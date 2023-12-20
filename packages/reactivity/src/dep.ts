import { ReactiveEffect, trackOpBit } from './effect'

export type Dep = Set<ReactiveEffect> & TrackedMarkers

/**
 * wasTracked and newTracked maintain（维持） the status for several levels of effect
 * tracking recursion递归. One bit per level is used to define whether the dependency
 * was/is tracked.
 */
type TrackedMarkers = {
  /**
   * wasTracked
   */
  w: number
  /**
   * newTracked
   */
  n: number
}

export const createDep = (effects?: ReactiveEffect[]): Dep => {
  const dep = new Set<ReactiveEffect>(effects) as Dep
  dep.w = 0
  dep.n = 0
  return dep
}

export const wasTracked = (dep: Dep): boolean => (dep.w & trackOpBit) > 0

export const newTracked = (dep: Dep): boolean => (dep.n & trackOpBit) > 0

/**
 * 初始化dep.w
 */
export const initDepMarkers = ({ deps }: ReactiveEffect) => {
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      // 按位或 默认设置已被收集
      deps[i].w |= trackOpBit // set was tracked
    }
  }
}

/**
 * 清空失效的依赖
 */
export const finalizeDepMarkers = (effect: ReactiveEffect) => {
  // 该副作用相关的所有的依赖集合
  const { deps } = effect
  if (deps.length) {
    let ptr = 0
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i]
      // 新的一轮中不包含dep，则dep中删除此effect，那effect相关的依赖中也不需要此dep了，
      // 通过ptr在else语句中顺便把该dep从deps中也删除了
      if (wasTracked(dep) && !newTracked(dep)) {
        dep.delete(effect)
      } else {
        // 需要保留的依赖，放到数据的较前位置，因为在最后会删除较后位置的所有依赖
        deps[ptr++] = dep
      }
      // clear bits
      // 清理 was 和 new 标记，将它们对应深度的 bit，置为 0
      dep.w &= ~trackOpBit
      dep.n &= ~trackOpBit
    }
    // 删除依赖，只保留需要的
    deps.length = ptr
  }
}
