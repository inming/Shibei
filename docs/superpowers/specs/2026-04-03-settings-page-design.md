# 设置页拆分设计

## 背景

当前所有设置（S3 连接、加密、同步间隔）堆在一个弹窗 `SyncSettings.tsx` 中，随着配置项增多（未来可能有外观、快捷键等），需要拆分为独立的设置页面。

## 设计

### 整体结构

- 设置页作为一个 Tab 打开，与阅读器 Tab 并列，关闭 Tab 即退出
- 左侧固定宽度导航栏（~160px），右侧内容区居中限宽（max-width ~520px）
- 初始两个导航项：「同步」「加密」，未来可扩展

### 导航项与内容

#### 同步

- S3 连接配置（endpoint、region、bucket、access key、secret key）
- 测试连接 + 保存按钮
- 自动同步间隔下拉选择
- 上次同步时间显示

#### 加密

- 加密状态提示（未启用 / 已启用未解锁 / 已解锁）
- 对应操作按钮（启用加密 / 输入密码解锁 / 修改密码）
- 密码输入表单内联展示

### 进入方式

- Sidebar SyncStatus 组件的设置按钮触发 `onOpenSettings` 回调
- App 层接收回调，打开「设置」Tab（单例，不重复打开）

### 文件变动

| 操作 | 文件 | 说明 |
|------|------|------|
| 新建 | `src/components/SettingsView.tsx` | 设置页容器，侧栏导航 + 内容区路由 |
| 新建 | `src/components/SettingsView.module.css` | 设置页样式 |
| 新建 | `src/components/Settings/SyncPage.tsx` | 同步设置内容（从 SyncSettings 提取） |
| 新建 | `src/components/Settings/EncryptionPage.tsx` | 加密设置内容（从 SyncSettings 提取） |
| 修改 | `src/components/Layout.tsx` | 移除 SyncSettings 弹窗，改为触发打开设置 Tab |
| 修改 | `src/components/SyncStatus.tsx` | onOpenSettings 回调不变，但不再打开弹窗 |
| 修改 | `src/App.tsx`（或 Tab 管理处） | 支持「设置」Tab 类型 |
| 删除 | `src/components/SyncSettings.tsx` | 被拆分后的组件替代 |
| 删除 | `src/components/SyncSettings.module.css` | 同上 |

### 布局约束

- 导航栏宽度：160px，固定不可调
- 内容区：flex: 1，内部表单 max-width: 520px，居中（margin: 0 auto）
- 导航项高亮当前选中项
- 整体填满 Tab 内容区域（全宽全高）
