import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.

// 存储｛target->key->dep｝连接的主WeakMap。从概念上讲，更容易将依赖项视为Dep类
// 它维护一组订阅者，但我们只是将它们存储为raw设置以减少内存开销
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
// 当前正在递归跟踪的effect数。
let effectTrackDepth = 0

export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 * 逐位跟踪标记最多支持30个递归级别。选择此值是为了使现代JS引擎能够在所有平台上使用SMI。当递归深度较大时，返回使用完全清理。
 */
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 当前激活的副作用
export let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '') // 重复、反复
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export class ReactiveEffect<T = any> {
  // 用于标识副作用函数是否位于响应式上下文中被执行 当前副作用是否可用
  active = true
  deps: Dep[] = [] // 订阅者集合 副作用依赖的订阅者
  parent: ReactiveEffect | undefined = undefined // 父指针

  /**
   * Can be attached after creation
   * @internal
   * 创建后可以附加 computed
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   * 是否允许递归：在beforeUpdate、beforeMount、pre-lifecycle生命周期钩子中不允许递归、组件渲染副作用允许递归更新
   */
  allowRecurse?: boolean
  /**
   * @internal 是否延迟清理
   */
  private deferStop?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    recordEffectScope(this, scope) // effect作用域
  }

  run() {
    // 如果是无效的，返回fn的值
    if (!this.active) {
      return this.fn()
    }
    // 默认父级是当前副作用
    let parent: ReactiveEffect | undefined = activeEffect
    let lastShouldTrack = shouldTrack // 是否应该收集
    // 判断当前的副作用是否存在, 如果已经初始化过则跳过处理
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      this.parent = activeEffect
      activeEffect = this // 将effect设置为当前副作用
      shouldTrack = true // 开始收集

      trackOpBit = 1 << ++effectTrackDepth // 获取当前副作用追踪深度 每次基于上次扩大2倍

      if (effectTrackDepth <= maxMarkerBits) {
        // 初始化标记deps
        initDepMarkers(this)
      } else {
        cleanupEffect(this)
      }
      // 返回fn的值
      return this.fn()
    } finally {
      // 清空失效的依赖
      if (effectTrackDepth <= maxMarkerBits) {
        finalizeDepMarkers(this)
      }

      trackOpBit = 1 << --effectTrackDepth // 恢复追踪深度

      activeEffect = this.parent // 指向副作用栈中的下一个
      shouldTrack = lastShouldTrack
      this.parent = undefined // 从栈中删除该副作用

      if (this.deferStop) {
        this.stop()
      }
    }
  }

  stop() {
    // stopped while running itself - defer the cleanup
    // 如果当前副作用是自己，等执行完再终止
    if (activeEffect === this) {
      this.deferStop = true
    } else if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false // 标识当前副作用不可用 已经执行结束
    }
  }
}

/**
 * 从deps中清除该副作用，将effect.deps长度置为0
 * @param effect
 */
function cleanupEffect(effect: ReactiveEffect) {
  // 获取所有有effect函数的依赖（订阅器）
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      // 从依赖（订阅器）中清除
      deps[i].delete(effect)
    }
    // 清除之后就没有任何与之相关的依赖（订阅器），值为0
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean // 延迟执行
  scheduler?: EffectScheduler // 调度器
  scope?: EffectScope // 作用域
  allowRecurse?: boolean // 是否允许递归
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

/**
 * Registers the given function to track reactive updates.
 * 注册给定的函数以跟踪反应式更新。
 *
 * The given function will be run once immediately. Every time any reactive
 * property that's accessed within it gets updated, the function will run again.
 * 给定的函数将立即运行一次。每次任何访问的reactive 属性得到更新时，该函数将再次运行。
 *
 * @param fn - The function that will track reactive updates.
 * @param options - Allows to control the effect's behaviour.
 * @returns A runner that can be used to control the effect after creation.
 */
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  // 如果fn已经是effect函数了，则指向原来的函数
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 创建副作用函数
  const _effect = new ReactiveEffect(fn)
  // 将options更新到effect上，记录作用域
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  // 如果没有options或者不是懒加载则执行_effect.run
  if (!options || !options.lazy) {
    _effect.run()
  }
  // 将函数执行的方法返回出去 bind延迟执行
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

/**
 * Stops the effect associated with the given runner.
 *
 * @param runner - Association with the effect to stop tracking.
 */
export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

export let shouldTrack = true // 默认应该收集
const trackStack: boolean[] = [] // 是否应该收集依赖关系的栈

/**
 * Temporarily pauses tracking. 在所有的生命周期钩子中禁止收集，因为他们可能被内部的effect调用；执行setup、flushPreFlushCbs时也禁止收集
 */
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */
export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * Tracks access to a reactive property.
 *
 * This will check which effect is running at the moment and record it as dep
 * which records all effects that depend on the reactive property.
 * 检查当前哪些副作用在运行，将它记录为依赖 记录了所有依赖于响应式属性的副作用
 * @param target - Object holding the reactive property.
 * @param type - Defines the type of access to the reactive property.
 * @param key - Identifier of the reactive property to track.
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 当前副作用、应该收集
  if (shouldTrack && activeEffect) {
    // 获取目标对象的副作用集合们
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }
    // 获取key的副作用集合dep
    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined
    // 收集依赖
    trackEffects(dep, eventInfo)
  }
}

// 收集和副作用相关的依赖集合
/**
 * dep中没有当前激活的副作用，或者dep之前没收集过，新的也没收集过，shouldTrack为true
 * @param dep
 * @param debuggerEventExtraInfo
 */
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      dep.n |= trackOpBit // set newly tracked
      shouldTrack = !wasTracked(dep) // 更新shouldTrack
    }
  } else {
    // Full cleanup mode.
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) {
    dep.add(activeEffect!)
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        extend(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo!
        )
      )
    }
  }
}

/**
 * Finds all deps associated with the target (or a specific property) and
 * triggers the effects stored within.
 * 找到所有的有关target的dep，触发副作用
 * @param target - The reactive object.
 * @param type - Defines the type of the operation that needs to trigger effects.
 * @param key - Can be used to target a specific reactive property in the target object.
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    const newLength = Number(newValue)
    depsMap.forEach((dep, key) => {
      // https://zhuanlan.zhihu.com/p/614468288
      // 举个例子, array.splice(1, 0, 'a')，我们插入了一个元素，这个元素会导致这个元素后面的元素index发生变化，
      // 这个时候就需要收集对它们有依赖的effect，而这个插入元素之前的并不需要收集，因为没有发生改变
      // 数组长度变短时
      if (key === 'length' || key >= newLength) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 如果 key 不是 undefined，就添加对应依赖到队列，比如新增、修改、删除
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 也为ADD|DELETE|Map上的迭代键运行
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    // 收集所有的副作用
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    // 副作用->订阅器->触发
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

/**
 * 遍历dep中的副作用（先computed，后非computed），触发执行
 * @param dep
 * @param debuggerEventExtraInfo
 */
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization 固定
  // dep统一转换为数组
  const effects = isArray(dep) ? dep : [...dep]
  // 先执行带有computed属性的副作用
  for (const effect of effects) {
    if (effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
  // 再执行没用computed属性的副作用
  for (const effect of effects) {
    if (!effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
}

/**
 * 执行单个副作用
 * 不是当前激活的副作用或者副作用允许递归才能触发，优先执行scheduler，否则执行run
 * @param effect
 * @param debuggerEventExtraInfo
 */
function triggerEffect(
  effect: ReactiveEffect,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  /**
   * 这里判断 effect !== activeEffect的原因是：不能和当前激活的effect 相同
      比如：count.value++，如果这是个effect，会触发getter，track收集了当前激活的 effect，
      然后count.value = count.value+1 会触发setter，执行trigger，
      就会陷入一个死循环，所以要过滤当前的 effect
   */
  if (effect !== activeEffect || effect.allowRecurse) {
    if (__DEV__ && effect.onTrigger) {
      effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
    }
    if (effect.scheduler) {
      effect.scheduler()
    } else {
      effect.run()
    }
  }
}
/**
 * getDepFromReactive：获取依赖属性的副作用集合
 * @param object
 * @param key 依赖属性
 * @returns
 */
export function getDepFromReactive(object: any, key: string | number | symbol) {
  return targetMap.get(object)?.get(key)
}
