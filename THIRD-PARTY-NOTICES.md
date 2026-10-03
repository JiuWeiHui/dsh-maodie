# 第三方声明（Third-Party Notices）

本项目以 MIT 许可发布。下面列出我们**借鉴过思路或数据**的第三方作品。

## dsh-whale-widget（MIT）

- 用途：**借鉴实现思路**（不是搬运代码）
- 借鉴内容：
  - 「每轮对话的金额 = 每次模型调用的真实 usage × 该模型单价，按 `(会话 id, 轮次)` 分桶累加」，
    从而在主会话与子代理并行时不会串账；
  - 价目表的组织方式（按模型存 `hit/miss/out` 三档、并区分峰谷价），以及
    「`reasoningTokens ⊆ outputTokens`，输出侧不重复计费」这条口径修正。
- 我们的实现是独立编写的：函数、数据结构、注释与调用流程均为自己设计。
- 许可原文（随附）：

```
MIT License

Copyright (c) 2026 MeteorNOX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek 官方定价页（数据来源）

- 单价数字、峰谷时段（工作日 9:00-12:00、14:00-18:00，北京时间）、周末全天谷价的生效日期，
  均取自 DeepSeek 官方定价页 https://api-docs.deepseek.com/zh-cn/quick_start/pricing 。
  价格属于事实数据，且会随官方调整而变化 —— **以官方页面为准**，插件里的数字只是默认参考值，
  可在设置 → 用量 的单价表里自行修改。
