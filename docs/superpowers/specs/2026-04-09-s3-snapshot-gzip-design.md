# S3 快照 Gzip 压缩

## 目标

减少 S3 存储占用和传输带宽。仅压缩 S3 端的快照 HTML 文件，本地保持原始 HTML 不变。

## 背景

- 快照文件（SingleFile 生成的内联 HTML）通常几百 KB 到几 MB
- 当前上传/下载均为原始字节，无任何压缩
- HTML 文本 gzip 压缩率通常在 70-85%（1MB → 150-300KB）
- 只压缩快照 HTML，不压缩 JSONL 同步日志

## 设计

### 数据流

```
上传：本地 snapshot.html → gzip 压缩 → EncryptedBackend 加密 → S3
下载：S3 → EncryptedBackend 解密 → gzip 解压 → 本地 snapshot.html
```

压缩在加密之前（加密后数据不可压缩）。

### S3 Key 变更

```
旧：snapshots/{resource_id}/snapshot.html
新：snapshots/{resource_id}/snapshot.html.gz
```

后缀 `.gz` 明确标识文件格式，语义清晰。

### 新增依赖

- `flate2` crate — Rust 标准 gzip 压缩库，纯 Rust 实现，轻量成熟
- 压缩级别：gzip level 6（默认，压缩率与速度的平衡点）

### 改动点

#### 1. `upload_snapshot`（engine.rs）

读取本地 `snapshot.html` → `flate2::write::GzEncoder` 压缩 → 上传到 `snapshots/{id}/snapshot.html.gz`。

#### 2. `download_snapshot`（engine.rs）

从 S3 下载 `snapshot.html.gz` → `flate2::read::GzDecoder` 解压 → 写入本地 `snapshot.html`。

#### 3. 其他 S3 key 引用（engine.rs，约 5 处）

所有硬编码 `snapshot.html` 的 S3 key 改为 `snapshot.html.gz`：
- 全量导出中列举 snapshot 的 key 匹配逻辑
- Compaction 中补传快照的 key 构建
- 检查 snapshot 是否已存在的 key 查询

#### 4. 自动迁移

首次同步时自动执行，用户无感：

- **触发条件**：同步流程中检查 `sync_state` 标志位 `config:snapshots_gzip_migrated`，值不为 `"done"` 则触发迁移
- **迁移逻辑**：
  1. 列举 S3 上所有 `snapshots/*/snapshot.html` key
  2. 逐个：下载原始数据 → gzip 压缩 → 上传为 `snapshot.html.gz` → 删除旧 `snapshot.html` key
  3. 写入 `sync_state` 标志位 `config:snapshots_gzip_migrated = "done"`
- **幂等性**：已迁移的文件（旧 key 不存在）自动跳过
- **进度回调**：复用现有同步进度事件通知前端

### 不改动的

- 本地存储格式（始终是原始 `snapshot.html`）
- JSONL 同步日志格式
- `shibei://` 自定义协议读取逻辑
- `EncryptedBackend` / `S3Backend` 接口和实现
- HTTP Server 的保存端点

### 测试

- 单元测试：压缩 → 解压 round-trip 验证数据一致性
- 集成测试：`upload_snapshot` + `download_snapshot` 端到端验证（使用 `MockBackend`）
- 迁移测试：模拟旧格式 key 存在 → 迁移后新 key 存在、旧 key 删除
