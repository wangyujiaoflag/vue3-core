# 调试学习手册

## 如何调试

```bash
# pnpm install
# 检查 scripts/dev中的sourcemap 是否开启,没开启就打开
# npm run dev
# 打开 packages/vue/examples 中的示例文件进行调试
# 配置launch.json文件
    {
      "name": "Launch Chrome",
      "type": "chrome",
      "request": "launch",
      "url": "http://localhost:8080",
      "webRoot": "${workspaceFolder}",
      "file": "${workspaceFolder}/packages/vue/examples/composition/${fileBasename}"
    },
    ## ts
    {
      "type": "node",
      "request": "launch",
      "name": "Launch TS",
      "runtimeArgs": ["-r", "ts-node/register"],
      "args": ["${workspaceFolder}/test.ts"]
    }
```

## 目录结构

├── compiler-core // 核心编译模块，抽象语法树和渲染桥接实现
├── compiler-dom // DOM的实现
├── compiler-sfc // Vue单文件组件(.vue)的实现
├── compiler-ssr
├── dts-test
├── reactivity // 响应式处理
├── reactivity-transform
├── runtime-core
├── runtime-dom // 程序运行时(即程序被编译之后)的DOM处理
├── runtime-test
├── server-renderer // 服务端渲染实现
├── sfc-playground  
├── shared // package 之间共享的工具库
├── template-explorer
├── vue
└── vue-compat
├── global.d.ts
