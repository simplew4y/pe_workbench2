# 项目切换菜单滚动 · Dev Summary

> 存放说明：任务要求写到 `/workspace/projects/_chief/tasks/project-menu-scroll/dev-summary.md`，但该目录所在文件系统对本执行器只读（`Read-only file system`），且无审批通道可提权。故同内容副本放在本仓库根目录并随分支提交，供 Chief 验收时取用。

| 字段 | 内容 |
|------|------|
| 分支 | `fix/project-menu-scroll`（基线 `main` @ `4dc5b21`） |
| Commit | `91fc27b` fix(ui): make project switcher menu scroll with many projects |
| 执行器 | DSH |
| 推送 | **未 push / 未 merge** |
| 改动 | 仅 `styles.css`（+14 / -4），无业务逻辑、无 DOM id 变更 |

## 根因复现

用真实 server + 临时 storage 造 27 个项目，在 1440×700 视口打开菜单：

```text
menu  top=117.25  bottom=1443.25  height=1326
list  overflow-y=visible  scrollHeight=1241  clientHeight=1241  scrollTop=0
last  bottom=1389.25（视口外，点不到）
newProjectBtn bottom=1438.25（被顶出视口）
```

确认根因与 BRIEF 一致：`.ws-menu` / `.ws-menu-list` 没有 `max-height` / `overflow-y`，菜单按项目数撑高，超出视口部分不可达。

## 改动内容（`styles.css`）

1. `.ws-menu`
   - `display:flex; flex-direction:column; overflow:hidden;`
   - `max-height:min(70vh, calc(100dvh - 72px));`
   - 新增 `.ws-menu[hidden]{display:none}`：`display:flex` 是作者样式，会覆盖 UA 的 `[hidden]`，必须显式补回，否则菜单无法关闭。
2. `.ws-menu-list`
   - `flex:1 1 auto; min-height:0; overflow-y:auto;`
   - `overscroll-behavior:contain;`
   - `padding-bottom:2px`（最后一项不贴边）。
3. 固定区保持不滚动
   - `.ws-menu-label`、`.ws-menu .menu-sep`、`.ws-new` 均 `flex:none`；label / 分隔线 / 「新建项目」仍在 list 外，窄视口下不被压缩。
4. 未改 `index.html`、`ui/bootstrap.js`，`#wsMenu` `#projectMenuList` `#newProjectBtn` 及切换/新建逻辑原样。

## 如何测试

Playwright（headless Chrome）+ 真实 HTTP server，`WORKBENCH_STORAGE_ROOT` 指向临时目录，`PI_FAKE_AGENT=1`，通过 `POST /api/projects` 造 26 个假项目（含默认项目共 27 个）。临时测试脚本未提交。

每个视口执行：

1. 点击 `#workspaceBtn` 打开菜单；
2. 断言菜单、label、「新建项目」都在视口内；`.ws-menu` 为 flex column、overflow hidden；
3. 断言 list 可滚动（`scrollHeight > clientHeight`），鼠标滚轮后 `scrollTop > 0`；
4. `scrollTop = scrollHeight` 后断言最后一项在列表/视口内，label 与「新建项目」仍可见；
5. 点击最底部项目，断言菜单关闭且 `#wsName` 更新为该项目；
6. 再打开、滚到底后点「新建项目」，断言 `#projectDialog` 打开，取消关闭；
7. 点击菜单外区域，断言菜单关闭。

覆盖视口：`1440×700`（BRIEF 的短视口）、`1280×960`、`1024×640`（窄侧边栏）。

结果：

```text
[1440x700] menu bottom=607.25  list client=405 scroll=1243  PASS
[1280x960] menu bottom=789.25  list client=587 scroll=1243  PASS
[1024x640] menu bottom=565.25  list client=363 scroll=1243  PASS
PROJECT MENU SCROLL PASS
```

修复后 1440×700 实测：菜单高 490px（70vh），list 405px 可滚动，最后一项滚到底后可点；label 与「新建项目」全程固定可见。截图核对无裁切、无重叠。

回归：

```text
node scripts/test-f5-ui.mjs   # F5 UI PASS
```

菜单开关、项目切换、新建项目对话框、点击外部关闭均通过；会话列表 CSS 未改动。

## 已知限制

- 仅验证 Chrome（headless, Linux）。Safari / iOS 触摸滚动未实机验证；`overscroll-behavior` 在旧 Safari 上可能被忽略（不影响基本滚动）。
- 菜单高度按视口计算，未按锚点上方剩余空间动态调整；`70vh` 在超高视口下会主动留白，属预期。
- 列表使用浏览器默认滚动条，未额外并入 `.sessions` 的自定义滚动条样式。
- 未覆盖真实 18+ 线上项目数据；用 27 个假项目验证，数量更多时行为一致。
- 未 push、未 merge、未部署；等 Chief 验收。
- 任务要求的 `_chief/tasks/project-menu-scroll/dev-summary.md` 因文件系统只读未能写入；本文件为同内容副本。
