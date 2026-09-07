# dsh-chat-import 侧边栏 footer 布局修复 —— 持久化补丁说明

> 本文记录 DSH web profile 里 `dsh-chat-import` 插件的一处 UI 布局修复，
> 以及如何用 pnpm 的 `patchedDependencies` 让它跨重装/升级持续生效。
> **供以后升级 `dsh-chat-import` 时照做。** 该补丁作用于 profile
> （`~/.dsh/profiles/web/`），不在本 git 仓库内；本文只记录流程。

## 背景

DSH web profile（`~/.dsh/profiles/web/`）中，`dsh-chat-import` 会把「导入会话」
按钮注册进 `sidebar.footer.action` 槽。该槽的容器是宿主 `ui-sidebar` 的
`footerActions`，默认 `display: flex; flex-direction: row; flex-wrap: nowrap`。

同一槽里 `@kenz1117/dsh-ui-usage-billing` 的「当月用量」卡片（`order: -10`）在
前面，两者并排共享一行 256px 宽空间。由于卡片较宽且可收缩，`dsh-chat-import`
按钮（`order: 0`，`flex: 1 1 auto; min-width: 0`）会被 `flex-shrink` 挤成竖排窄条。
（插件市场更新后，原可作「整行占用者」锚定的 cordis 徽标 / `.dshMarketLauncher`
从该行消失，无法再触发按钮的“浮动独占一行”逻辑，才会落入并排共享。）

## 三处改动（`dsh-chat-import/lib/client.js`）

1. **行内共享分支的 `min-width: 0` → `min-width: "fit-content"`**
   ```js
   // 原：{ flex: "1 1 auto", width: "auto", minWidth: 0 }
   // 改：{ flex: "1 1 auto", width: "auto", minWidth: "fit-content" }
   ```
   按钮保底内容宽度，不再被前面的宽卡片挤到不可读；仍保留“单独入口撑满整行”
   和“与窄条目共享剩宽”的行为。

2. **注册 `sidebar.footer.action` 的 `order: 0` → `order: -20`**
   ```js
   // 原：{ name: "sidebar.footer.action", id: "chat-import", order: 0 }
   // 改：{ name: "sidebar.footer.action", id: "chat-import", order: -20 }
   ```
   让「导入会话」排在 usage-billing（`order: -10`）之上，构成
   「导入会话 → 每月用量 → cordis(若有)」自上而下的顺序。

3. **`apply()` 注入一条 CSS，把 footer 容器改成纵向堆叠**
   ```js
   if (typeof document !== "undefined" && !document.querySelector("style[data-dsh-import-footer-stack]")) {
     const tag = document.createElement("style");
     tag.dataset.dshImportFooterStack = "1";
     tag.textContent = "div:has(> [data-slot='sidebar.footer.action']) { flex-direction: column; }";
     document.head.appendChild(tag);
   }
   ```
   用 `:has()` 锁定真实容器（槽锚点 `[data-slot]` 自身是 `display: contents`，直接设
   `flex-direction` 不生效），不硬编码 CSS-module 哈希类名（如 `hHd-Xa_footerActions`）。
   改成 `column` 后每个条目占满宽、各自独立成行。

## 持久化机制

pnpm `patchedDependencies`（`nodeLinker: hoisted` 的 workspace 根），注册写在了
`~/.dsh/profiles/web/pnpm-workspace.yaml`：

```yaml
patchedDependencies:
  dsh-chat-import@0.8.3: patches/dsh-chat-import@0.8.3.patch
```

补丁文件：`~/.dsh/profiles/web/patches/dsh-chat-import@0.8.3.patch`。

每次执行 `pnpm install` 或 `dsh plugin --profile web update <pkg>` 时，pnpm 会重新
解出原厂 `dsh-chat-import@0.8.3` 并自动套用该补丁，三处修复自动恢复，不再依赖
手工改 node_modules。

## 升级 `dsh-chat-import` 后重新打补丁

`patchedDependencies` 的 key 带版本号（`0.8.3`），**升级到新版本后必须重新生成**。
步骤：

1. 进入 profile 目录：
   ```sh
   cd ~/.dsh/profiles/web
   ```

2. 升级到新版本（示例，按实际版本操作）：
   ```sh
   dsh plugin --profile web update dsh-chat-import
   pnpm install
   ```

3. 编辑 `node_modules/dsh-chat-import/lib/client.js`，按上文「三处改动」重新应用。

4. 生成补丁：
   ```sh
   pnpm patch dsh-chat-import@<实际版本>
   # 记下打印出的可编辑目录，形如 node_modules/.pnpm_patches/dsh-chat-import@<版本>
   cp node_modules/dsh-chat-import/lib/client.js "<补丁目录>/lib/client.js"
   pnpm patch-commit "<补丁目录>"
   ```
   `patch-commit` 会生成新的 `patches/dsh-chat-import@<版本>.patch` 并更新
   `pnpm-workspace.yaml` 的 `patchedDependencies`。

5. 验证已套用：
   ```sh
   grep -c 'minWidth: "fit-content"' node_modules/dsh-chat-import/lib/client.js   # 1
   grep -c 'order: -20'               node_modules/dsh-chat-import/lib/client.js   # ≥1
   grep -c 'dsh-import-footer-stack'  node_modules/dsh-chat-import/lib/client.js   # 1
   ```

6. 刷新 DSH web 页面（它从磁盘实时 serve 客户端 bundle），确认侧边栏底部为
   「导入会话」在上、「每月用量」在下，各自独占一行。

## 注意事项

- 补丁**按版本精确匹配**；跨版本升级时，需核对上述三处改动是否仍适用于新源码。
- 若宿主 `ui-sidebar` 结构变化（`footerActions` 类名、`[data-slot]` 结构或
  `sidebar.footer.action` 槽行为改变），CSS 的 `:has()` 选择器可能失效，需按新结构调整。
- `patches/` 与 `pnpm-workspace.yaml` 都位于 `~/.dsh/profiles/web/`（属于 profile 的
  本地状态，**不在**本 git 仓库内）。本文档仅作为升级时的手册。
