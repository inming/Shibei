# HarmonyOS 开发机一次性配置

本项目的鸿蒙端 `libshibei_core.so` 是 Rust 交叉编译产物，**不进 git**。每台
新开发机（DevEco Studio 可用的 macOS / Windows）需要按下面步骤装一次工具链，
之后 `git pull` + `scripts/build-harmony-napi.sh release` 就能产出 `.so`。

## 1. DevEco Studio

装 DevEco Studio 5.x（对应 HarmonyOS NEXT API 12+）。SDK 装完后 DevEco 会把
NDK 释放到：

```
macOS:   /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native
Windows: %LOCALAPPDATA%\Huawei\Sdk\openharmony\native
```

确认该目录下有 `llvm/`、`sysroot/`、`toolchains/` 子目录。

## 2. 环境变量

把 NDK 路径 export 为 `OHOS_NDK_HOME`。macOS `.zshrc`：

```bash
export OHOS_NDK_HOME="/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/native"
export PATH="$OHOS_NDK_HOME/llvm/bin:$PATH"
```

Windows PowerShell：

```powershell
[Environment]::SetEnvironmentVariable("OHOS_NDK_HOME", "C:\Users\<you>\AppData\Local\Huawei\Sdk\openharmony\native", "User")
```

打开新终端让变量生效。

## 3. Rust toolchain + OHOS target

```bash
rustup target add aarch64-unknown-linux-ohos
```

（若提示找不到 target，运行 `rustup update stable` 后重试。）

`.cargo/config.toml`（仓库根部）已配置 linker 用 `aarch64-unknown-linux-ohos-clang`，
它来自 `$OHOS_NDK_HOME/llvm/bin/`。上一步 PATH 设好就自动找到。

## 4. 建 `.so`

在仓库根：

```bash
scripts/build-harmony-napi.sh release
```

首次约 1~2 分钟。产物路径：

```
shibei-harmony/entry/libs/arm64-v8a/libshibei_core.so
```

## 5. 在 DevEco 里打开

- **File → Open →** 选 `<repo>/shibei-harmony/`（不是仓库根）
- 首次打开会 sync `oh-package.json5` 和 `types/libshibei_core/` 下的 `.d.ts`
- USB 连手机，▶ Run

## 何时需要重跑 `.so` 构建

**必须重跑** 当以下任一路径有改动：

- `src-harmony-napi/src/**` （commands.rs / state.rs / runtime.rs 等）
- `crates/shibei-{db,sync,storage,events,backup,pairing,napi-*}/src/**`
- `src-harmony-napi/generated/shim.c` 或 `bindings.rs`（codegen 产出，commands 改
  后 `cargo run -p shibei-napi-codegen` 自动刷新）

**不需要重跑** 当只有 ArkTS（`shibei-harmony/entry/src/main/ets/**`）或
`.d.ts`（`shibei-harmony/entry/types/**`）有改动 —— DevEco 自己处理。

## 常见问题

### `[Fail]ExecuteCommand need connect-key`

`hdc` 看不到设备。DevEco 打开时占 hdc server；关掉 DevEco 再 `hdc kill; hdc start`，
或者直接在 DevEco 的内置 Terminal 里跑 hdc 命令。

### DevEco Run 后手机上跑的还是旧 `.so`

1. 手机长按应用图标 → 卸载；**或** `hdc shell bm uninstall -n com.shibei.harmony.phase0`
2. DevEco **Build → Clean Project**
3. ▶ Run
