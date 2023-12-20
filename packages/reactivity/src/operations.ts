// using literal strings instead of numbers so that it's easier to inspect
// debugger events

/**
 * 依赖收集、触发的几种方式
 */
export const enum TrackOpTypes {
  GET = 'get',
  HAS = 'has',
  ITERATE = 'iterate'
}

export const enum TriggerOpTypes {
  SET = 'set',
  ADD = 'add',
  DELETE = 'delete',
  CLEAR = 'clear'
}
