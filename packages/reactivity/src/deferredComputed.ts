import { Dep } from './dep'
import { ReactiveEffect } from './effect'
import { ComputedGetter, ComputedRef } from './computed'
import { ReactiveFlags, toRaw } from './reactive'
import { trackRefValue, triggerRefValue } from './ref'

const tick = /*#__PURE__*/ Promise.resolve()
const queue: any[] = []
let queued = false // 锁

/**
 * 调度方法，向队列中添加fn
 * queue为false时，清空队列
 * @param fn
 */
const scheduler = (fn: any) => {
  queue.push(fn)
  if (!queued) {
    queued = true
    tick.then(flush)
  }
}

/**
 * 执行队列中的方法，然后清空队列，重置queued
 */
const flush = () => {
  for (let i = 0; i < queue.length; i++) {
    queue[i]()
  }
  queue.length = 0
  queued = false
}

class DeferredComputedRefImpl<T> {
  public dep?: Dep = undefined

  private _value!: T
  private _dirty = true
  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true
  public readonly [ReactiveFlags.IS_READONLY] = true

  constructor(getter: ComputedGetter<T>) {
    let compareTarget: any
    let hasCompareTarget = false
    let scheduled = false
    this.effect = new ReactiveEffect(getter, (computedTrigger?: boolean) => {
      if (this.dep) {
        if (computedTrigger) {
          compareTarget = this._value
          hasCompareTarget = true
        } else if (!scheduled) {
          const valueToCompare = hasCompareTarget ? compareTarget : this._value
          scheduled = true
          hasCompareTarget = false
          scheduler(() => {
            if (this.effect.active && this._get() !== valueToCompare) {
              triggerRefValue(this)
            }
            scheduled = false
          })
        }
        // chained upstream computeds are notified synchronously to ensure
        // value invalidation in case of sync access; normal effects are
        // deferred to be triggered in scheduler.
        // 正常的effect在scheduler调度程序中触发
        // 同步通知上游的computed确保同步访问时值无效
        for (const e of this.dep) {
          if (e.computed instanceof DeferredComputedRefImpl) {
            e.scheduler!(true /* computedTrigger */)
          }
        }
      }
      this._dirty = true
    })
    this.effect.computed = this as any
  }

  private _get() {
    if (this._dirty) {
      this._dirty = false
      return (this._value = this.effect.run()!)
    }
    return this._value
  }

  get value() {
    // 收集依赖
    trackRefValue(this)
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    return toRaw(this)._get()
  }
}

export function deferredComputed<T>(getter: () => T): ComputedRef<T> {
  return new DeferredComputedRefImpl(getter) as any
}
