import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { Awaited, isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'

export interface SchedulerJob extends Function {
  id?: number
  pre?: boolean
  active?: boolean
  computed?: boolean
  /**
   * Indicates whether the effect is allowed to recursively trigger itself
   * when managed by the scheduler.
   *
   * By default, a job cannot trigger itself because some built-in method calls,
   * e.g. Array.prototype.push actually performs reads as well (#1740) which
   * can lead to confusing infinite loops.
   * The allowed cases are component update functions and watch callbacks.
   * Component update functions may update child component props, which in turn
   * trigger flush: "pre" watch callbacks that mutates state that the parent
   * relies on (#1801). Watch callbacks doesn't track its dependencies so if it
   * triggers itself again, it's likely intentional and it is the user's
   * responsibility to perform recursive state mutation that eventually
   * stabilizes (#1727).
   */
  /**
   * 当被scheduler管理的时候指定副作用是否允许递归的触发自己
   *
   * 默认情况下，因为一些内置的方法调用，任务不能触发自己，可能会导致混淆的无限循环
   * 允许自己调用自己的情况是组件更新函数和watch回调
   * 组件更新函数也许会更新子组件的props，从而会触发flush：pre、watch回调，从而改变父组件所依赖的状态
   * watch回调不会跟踪其依赖关系，因此，如果她再次触发了自己，很可能是故意的，用户有责任执行递归状态突变，最终稳定下来
   */
  allowRecurse?: boolean
  /**
   * Attached by renderer.ts when setting up a component's render effect
   * Used to obtain component information when reporting max recursive updates.
   * dev only.
   */
  /**
   * 设置组件的渲染副作用时由渲染器挂载
   * 用于在报告最大递归更新时获取组件信息
   * dev only
   */
  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

let isFlushing = false // 是否正在刷新
let isFlushPending = false // 刷新准备中

const queue: SchedulerJob[] = []
let flushIndex = 0

const pendingPostFlushCbs: SchedulerJob[] = []
let activePostFlushCbs: SchedulerJob[] | null = null // 保证不打破post任务的执行顺序
let postFlushIndex = 0

const resolvedPromise = /*#__PURE__*/ Promise.resolve() as Promise<any>
let currentFlushPromise: Promise<void> | null = null

const RECURSION_LIMIT = 100 // 递归限制 100
type CountMap = Map<SchedulerJob, number> // count map 每个任务的递归次数？

/**
 * nextTick
 * 放入微任务队列之后执行，保证在组件更新后执行
 * @param this
 * @param fn
 * @returns promise
 */
export function nextTick<T = void, R = void>(
  this: T,
  fn?: (this: T) => R
): Promise<Awaited<R>> {
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// #2768
// Use binary-search to find a suitable position in the queue,
// so that the queue maintains the increasing order of job's id,
// which can prevent the job from being skipped and also can avoid repeated patching.
/**
 * 使用二分搜索，在queue中找到适合的位置，使得序列递增
 * 可以阻止任务跳过或可以避免重复比较
 * @param id
 * @returns
 */
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJobId = getId(queue[middle])
    middleJobId < id ? (start = middle + 1) : (end = middle)
  }

  return start
}

/**
 * 将任务放到队列中合适的位置，将刷新的任务放到微任务中
 * @param job
 */
export function queueJob(job: SchedulerJob) {
  // the dedupe search uses the startIndex argument of Array.includes()
  // by default the search index includes the current job that is being run
  // so it cannot recursively trigger itself again.
  // if the job is a watch() callback, the search will start with a +1 index to
  // allow it recursively trigger itself - it is the user's responsibility to
  // ensure it doesn't end up in an infinite loop.
  /**
   * 重复数据消除搜索使用Array.includes（）的startIndex参数
   * 默认情况下，搜索索引包括正在运行的当前job，因此它不能再次递归地触发自己
   * 如果job是一个watch回调，将会从下一个索引开始允许递归触发自己，这是用户的责任确保它不会在一个无限循环中结束
   */
  if (
    !queue.length ||
    !queue.includes(
      job,
      isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
    )
  ) {
    // 将任务加入合适的位置
    if (job.id == null) {
      queue.push(job)
    } else {
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    // 队列刷新 一次dom更新之后执行一次 事件循环
    queueFlush()
  }
}

/**
 * 将刷新的任务放到微任务中
 */
function queueFlush() {
  // 更改状态 变为正在刷新
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    // 将刷新任务放到微任务中执行
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

/**
 * job大于刷新索引时，将该任务删除
 * @param job
 */
export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}
/**
 * 将post任务放到pendingPostFlushCbs中，并刷新队列，将任务添加到微任务中
 * @param cb
 */
export function queuePostFlushCb(cb: SchedulerJobs) {
  if (!isArray(cb)) {
    if (
      !activePostFlushCbs ||
      !activePostFlushCbs.includes(
        cb,
        cb.allowRecurse ? postFlushIndex + 1 : postFlushIndex
      )
    ) {
      pendingPostFlushCbs.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    // 生命周期钩子函数
    pendingPostFlushCbs.push(...cb)
  }
  queueFlush()
}

/**
 * 刷新前置pre回调数组
 * @param seen
 * @param i
 */
export function flushPreFlushCbs(
  seen?: CountMap,
  // if currently flushing, skip the current job itself
  i = isFlushing ? flushIndex + 1 : 0
) {
  if (__DEV__) {
    seen = seen || new Map()
  }
  for (; i < queue.length; i++) {
    const cb = queue[i]
    if (cb && cb.pre) {
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      queue.splice(i, 1)
      i--
      cb()
    }
  }
}
/**
 * 刷新post回调数组，清空
 * @param seen
 * @returns
 */
export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    // 去重
    const deduped = [...new Set(pendingPostFlushCbs)]
    // 清空准备执行的后置回调数组
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 添加到activePostFlushCbs
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 从小到大排序
    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

/**
 * id相同且其中一个没有pre，优先排有pre的
 * 否则从小到大排序
 * @param a
 * @param b
 * @returns
 */
const comparator = (a: SchedulerJob, b: SchedulerJob): number => {
  const diff = getId(a) - getId(b)
  if (diff === 0) {
    if (a.pre && !b.pre) return -1
    if (b.pre && !a.pre) return 1
  }
  return diff
}

/**
 * 刷新任务
 * @param seen
 */
function flushJobs(seen?: CountMap) {
  isFlushPending = false
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.
  // 刷新前队列重新进行排序
  // 确保：1，从父级更新到子级；2，父组件更新过程中，卸载了组件，可以跳过子组件的更新
  queue.sort(comparator)

  // conditional usage of checkRecursiveUpdate must be determined out of
  // try ... catch block since Rollup by default de-optimizes treeshaking
  // inside try-catch. This can leave all warning code unshaked. Although
  // they would get eventually shaken by a minifier like terser, some minifiers
  // would fail to do that (e.g. https://github.com/evanw/esbuild/issues/1610)
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        // 超出限制就继续下一个
        if (__DEV__ && check(job)) {
          continue
        }
        // console.log(`running:`, job.id)
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    flushIndex = 0
    queue.length = 0

    // dom渲染完成后，冲刷post队列： mounted/updated钩子函数会在这里面执行
    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null
    // some postFlushCb queued jobs!
    // keep flushing until it drains.（排干）
    // 如果在执行post冲刷任务的过程后，queue/post队列又被添加了job任务，那么则继续执行flushJobs，直到本轮更新完成
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

/**
 * 更新job的递归次数，检查是否超出限制
 * @param seen
 * @param fn
 * @returns
 */
function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
