# Phase 5.1 Task 0 — 鸿蒙 i18n key 清单

> 来源：扫描 `shibei-harmony/entry/src/main/ets/{pages,components,services}/*.ets` 全部硬编码中文。Total ~205 行 CJK，~85 个独立 key（折叠重复）。
>
> 命名约定：`<namespace>_<snake_case_id>`（鸿蒙 `string.json` 平铺，用 `_` 模拟 namespace）。
>
> 占位符：用 ArkTS `getStringSync` 原生 `%1$s` `%2$d` 风格。
>
> 翻译原则：与桌面 `src/locales/{zh,en}/*.json` 同义复用，不另起术语。

---

## common（通用，~15 key）

| key | zh | en | placeholder | 用法 |
|---|---|---|---|---|
| common_save | 保存 | Save | — | Reader / Settings 保存按钮 |
| common_cancel | 取消 | Cancel | — | 各对话框 |
| common_confirm | 确认 | Confirm | — | 各对话框 |
| common_delete | 删除 | Delete | — | AnnotationPanel |
| common_loading | 加载中… | Loading… | — | Library / Reader / pdf-shell |
| common_initializing | 初始化中… | Initializing… | — | Library |
| common_init_failed | 初始化失败：%1$s | Init failed: %1$s | err | Library / Onboard |
| common_retry | 重试 | Retry | — | Reader (PDF 错误) / Onboard |
| common_prev_step | 上一步 | Back | — | Onboard |
| common_next_step | 下一步 | Next | — | Onboard / LockScreen recovery |
| common_done | 完成 | Done | — | Onboard recovery / LockScreen |
| common_processing | 处理中… | Processing… | — | LockScreen recovery |
| common_copy_success | 链接已复制 | Link copied | — | Reader |
| common_copy_failed | 复制失败 | Copy failed | — | Reader |
| common_load_failed | 加载失败：%1$s | Load failed: %1$s | err | Reader |
| common_no_title | (无标题) | (untitled) | — | ResourceItem / Search |

## settings（~50 key，最大头）

| key | zh | en | placeholder |
|---|---|---|---|
| settings_page_title | 设置 | Settings | — |
| settings_section_appearance | 外观 | Appearance | — |
| settings_section_sync | 同步 | Sync | — |
| settings_section_security | 安全 | Security | — |
| settings_section_data | 数据 | Data | — |
| settings_theme_system | 跟随系统 | System | — |
| settings_theme_light | 浅色 | Light | — |
| settings_theme_dark | 深色 | Dark | — |
| settings_sync_now | 立即同步 | Sync Now | — |
| settings_sync_in_progress | 同步中… | Syncing… | — |
| settings_sync_preparing | 准备中… | Preparing… | — |
| settings_sync_complete | 同步完成 ↑%1$d ↓%2$d | Sync complete ↑%1$d ↓%2$d | uploaded, downloaded |
| settings_sync_skipped | 同步跳过 | Sync skipped | — |
| settings_sync_failed | 同步失败：%1$s | Sync failed: %1$s | err |
| settings_reset_cursors | 修复同步游标 | Reset Sync Cursors | — |
| settings_reset_cursors_busy | 修复中… | Resetting… | — |
| settings_reset_cursors_help | 本机比其他设备少资料时用此修复 | Use this if this device has fewer items than others | — |
| settings_reset_cursors_title | 修复同步游标 | Reset Sync Cursors | — |
| settings_reset_cursors_body | 这会清除「已同步到哪里」的记录，下次同步时全量拉取 S3 上的 snapshot 和增量日志补齐本地缺失。\n\n本地数据和云端数据都不会被删除。如果发现本机比其他设备少了资料，用这个修复。 | This clears the "synced up to" markers so the next sync re-downloads the full S3 snapshot and delta log to back-fill what's missing locally.\n\nNothing local or remote will be deleted. Use this if this device has fewer items than your other devices. | — |
| settings_reset_cursors_confirm | 确认修复 | Confirm Reset | — |
| settings_reset_cursors_success | 已清除 %1$d 条游标，点击「立即同步」重新拉取 | Cleared %1$d cursor(s). Tap "Sync Now" to re-pull. | n |
| settings_reset_cursors_failed | 修复失败：%1$s | Reset failed: %1$s | err |
| settings_reset_device | 重置设备 | Reset Device | — |
| settings_reset_device_busy | 重置中… | Resetting… | — |
| settings_reset_device_title | 重置设备 | Reset Device | — |
| settings_reset_device_body | 这会清除本地全部资料和凭据，下次启动需要重新配对云端。\n\n（云端数据不受影响，同步后会重新拉回） | This wipes all local data and credentials. You'll need to re-pair with the cloud on next launch.\n\n(Cloud data is untouched and will be re-pulled after sync.) | — |
| settings_reset_device_confirm | 确认重置 | Confirm Reset | — |
| settings_reset_device_failed | 重置失败：%1$s | Reset failed: %1$s | err |
| settings_data_disclaimer | 云端数据永不会被这些操作删除。 | Cloud data is never deleted by these operations. | — |
| settings_lock_enable | 启用 App 锁 | Enable App Lock | — |
| settings_lock_enabled_toast | App 锁已启用 | App Lock enabled | — |
| settings_lock_disabled_toast | App 锁已停用 | App Lock disabled | — |
| settings_lock_enable_failed | 启用失败：%1$s | Enable failed: %1$s | err |
| settings_lock_disable_failed | 停用失败：%1$s | Disable failed: %1$s | err |
| settings_lock_pin_incorrect | PIN 错误 | Incorrect PIN | — |
| settings_lock_old_pin_incorrect | 旧 PIN 错误 | Incorrect old PIN | — |
| settings_lock_pin_changed | PIN 已修改 | PIN updated | — |
| settings_lock_pin_change_failed | 修改失败：%1$s | Change failed: %1$s | err |
| settings_bio_unlock | 生物识别解锁 | Biometric Unlock | — |
| settings_bio_hint_no_enroll | 请先在系统设置中添加指纹或面部 | Add a fingerprint or face in System Settings first | — |
| settings_bio_enabled_toast | 生物识别已启用 | Biometric enabled | — |
| settings_bio_disabled_toast | 生物识别已停用 | Biometric disabled | — |
| settings_bio_toggle_failed | 切换失败：%1$s | Toggle failed: %1$s | err |
| settings_bio_enroll_title | 启用生物识别？ | Enable biometric? | — |
| settings_bio_enroll_message | 指纹或面部识别可以让日常解锁更快。 | Use fingerprint or face to unlock faster. | — |
| settings_bio_enroll_pin_only | 只用 PIN | PIN only | — |
| settings_bio_enroll_yes | 启用生物识别 | Enable biometric | — |
| settings_change_pin | 修改 PIN | Change PIN | — |
| settings_lock_now | 立即锁定 | Lock Now | — |
| settings_pin_set_prompt_enter | 设置 PIN（4 位数字） | Set PIN (4 digits) | — |
| settings_pin_set_prompt_confirm | 再输入一次确认 | Re-enter to confirm | — |
| settings_pin_must_be_4_digits | PIN 必须是 4 位数字 | PIN must be 4 digits | — |
| settings_pin_mismatch | 两次输入不一致 | PIN entries do not match | — |
| settings_pin_new_mismatch | 新 PIN 两次输入不一致 | New PIN entries do not match | — |
| settings_pin_disable_prompt | 输入当前 PIN 以停用 | Enter current PIN to disable | — |
| settings_pin_placeholder_4 | 4 位 PIN | 4-digit PIN | — |
| settings_pin_placeholder_old | 旧 4 位 PIN | Old 4-digit PIN | — |
| settings_pin_placeholder_new | 新 4 位 PIN | New 4-digit PIN | — |
| settings_pin_old_prompt | 输入旧 PIN | Enter old PIN | — |
| settings_pin_new_prompt | 输入新 PIN | Enter new PIN | — |

## onboard（~30 key）

| key | zh | en | placeholder |
|---|---|---|---|
| onboard_app_name | 拾贝 | Shibei | — |
| onboard_app_tagline | 个人只读资料库 | Personal read-only library | — |
| onboard_welcome_body | 连接你的桌面端，同步书签、笔记与全文搜索索引。 | Connect to your desktop to sync bookmarks, notes, and full-text search. | — |
| onboard_start | 开始 | Start | — |
| onboard_step_indicator | %1$d / %2$d | %1$d / %2$d | cur, total |
| onboard_step2_title | 配置云存储 | Configure Cloud Storage | — |
| onboard_step2_body | 扫描桌面端的配对二维码最快，也可以手动输入 S3 凭据。 | Scan the desktop pairing QR (fastest), or enter S3 credentials manually. | — |
| onboard_method_a_title | 方式 A：扫描桌面配对 QR | Method A: Scan desktop pairing QR | — |
| onboard_method_a_hint | 桌面：Settings → 同步 → 「添加移动设备」 | Desktop: Settings → Sync → "Add Mobile Device" | — |
| onboard_scan_button | 📷 扫码 | 📷 Scan | — |
| onboard_pin_placeholder_6 | 6 位 PIN | 6-digit PIN | — |
| onboard_apply_pin | 应用 | Apply | — |
| onboard_method_b_title | 方式 B：手动填写 | Method B: Manual entry | — |
| onboard_endpoint_placeholder | endpoint（https://… 留空走 AWS） | endpoint (https://… leave empty for AWS) | — |
| onboard_region_placeholder | region（如 us-east-1） | region (e.g. us-east-1) | — |
| onboard_bucket_placeholder | bucket | bucket | — |
| onboard_access_key_placeholder | access key | access key | — |
| onboard_secret_key_placeholder | secret key | secret key | — |
| onboard_config_required | 请填写 region / bucket / accessKey / secretKey（endpoint 可留空，走 AWS） | Please fill region / bucket / accessKey / secretKey (endpoint optional, defaults to AWS) | — |
| onboard_config_save_failed | 保存失败：%1$s | Save failed: %1$s | err |
| onboard_saving | 保存中… | Saving… | — |
| onboard_scan_opening | 打开扫描中… | Opening scanner… | — |
| onboard_scan_cancelled | 已取消扫描 | Scan cancelled | — |
| onboard_scan_success_info | 扫码成功 (%1$d 字节)，请在下方输入 6 位 PIN | Scan successful (%1$d bytes). Enter the 6-digit PIN below. | bytes |
| onboard_scan_failed | 扫码失败：%1$s | Scan failed: %1$s | err |
| onboard_scan_not_yet | 尚未扫码 | Not scanned yet | — |
| onboard_pin_must_be_6_digits | PIN 必须是 6 位数字 | PIN must be 6 digits | — |
| onboard_decrypt_success | 解密成功，5 项配置已自动填入 | Decrypted, 5 fields auto-filled | — |
| onboard_decrypt_failed | 解密失败：%1$s | Decrypt failed: %1$s | err |
| onboard_scan_toast | 扫码成功 | Scan successful | — |
| onboard_step3_title | 输入加密密码 | Enter Encryption Password | — |
| onboard_step3_body | 这是你在桌面端设置的主密码。它用于解开 E2EE 主密钥，不会上传。 | This is the master password you set on the desktop. It's used to unlock the E2EE master key and is never uploaded. | — |
| onboard_password_placeholder | 密码 | password | — |
| onboard_password_required | 请输入密码 | Please enter password | — |
| onboard_unlock_failed | 解锁失败：%1$s | Unlock failed: %1$s | err |
| onboard_unlocking | 解锁中… | Unlocking… | — |
| onboard_unlock | 解锁 | Unlock | — |
| onboard_step4_title | 首次同步 | First Sync | — |
| onboard_step4_body | 从云端拉取你的全部资料库。根据数据量可能需要几秒到几十秒。 | Pull your full library from the cloud. May take a few seconds to a minute depending on size. | — |
| onboard_phase_uploading | 上传本地变更 | Uploading local changes | — |
| onboard_phase_downloading | 下载远端变更 | Downloading remote changes | — |
| onboard_phase_downloading_snapshots | 下载快照 | Downloading snapshots | — |
| onboard_phase_done | 完成 | Done | — |
| onboard_sync_summary | 同步完成：上传 %1$d 条，下载 %2$d 条，应用 %3$d 条 | Sync complete: uploaded %1$d, downloaded %2$d, applied %3$d | u, d, a |
| onboard_sync_skipped | 同步已跳过（已在进行中？） | Sync skipped (already in progress?) | — |
| onboard_sync_failed | 同步失败：%1$s | Sync failed: %1$s | err |
| onboard_sync_start | 开始同步 | Start Sync | — |
| onboard_lock_enroll_title | 启用 App 锁？ | Enable App Lock? | — |
| onboard_lock_enroll_body | 设置 4 位 PIN，日常可以用指纹或面部快速解锁。 | Set a 4-digit PIN. You can use fingerprint or face for quick daily unlock. | — |
| onboard_lock_enroll_enter | 输入 4 位 PIN | Enter 4-digit PIN | — |
| onboard_lock_enroll_confirm | 再输入一次确认 | Re-enter to confirm | — |
| onboard_lock_enroll_pin_invalid | PIN 必须是 4 位数字 | PIN must be 4 digits | — |
| onboard_lock_enroll_pin_mismatch | 两次输入不一致，请重新输入 | PINs do not match, please re-enter | — |
| onboard_lock_enroll_failed | 启用失败：%1$s | Enable failed: %1$s | err |
| onboard_lock_skip | 暂不启用 | Skip for now | — |

## reader（~12 key）

| key | zh | en | placeholder |
|---|---|---|---|
| reader_loading | 加载中… | Loading… | — | (复用 common_loading 即可，删除) |
| reader_load_failed | 加载失败：%1$s | Load failed: %1$s | err | (复用 common_load_failed) |
| reader_pdf_downloading | 正在下载 PDF… | Downloading PDF… | — |
| reader_pdf_download_failed | 下载失败：%1$s | Download failed: %1$s | err |
| reader_create_failed | 创建失败：%1$s | Create failed: %1$s | err |
| reader_link_copied | 链接已复制 | Link copied | — | (复用 common_copy_success) |
| reader_copy_failed | 复制失败 | Copy failed | — | (复用 common_copy_failed) |
| reader_note_new | 新建笔记 | New Note | — |
| reader_note_edit | 编辑笔记 | Edit Note | — |
| reader_note_placeholder | 写下你的想法… | Write your thoughts… | — |
| reader_note_save | 保存 | Save | — | (复用 common_save) |
| reader_note_cancel | 取消 | Cancel | — | (复用 common_cancel) |
| reader_hl_color_yellow | 黄 | Yellow | — |
| reader_hl_color_green | 绿 | Green | — |
| reader_hl_color_blue | 蓝 | Blue | — |
| reader_hl_color_pink | 粉 | Pink | — |

## lock（LockScreen，~14 key）

| key | zh | en | placeholder |
|---|---|---|---|
| lock_title | 已锁定 | Locked | — |
| lock_use_biometric | 使用生物识别 | Use Biometric | — |
| lock_throttle_seconds | %1$d 秒后可重试 | Retry in %1$d sec | secs |
| lock_throttle_too_many | 连续错误，%1$d 秒后再试 | Too many failures. Retry in %1$d sec. | secs |
| lock_pin_error | PIN 错误 | Incorrect PIN | — |
| lock_unlock_failed | 解锁失败：%1$s | Unlock failed: %1$s | err |
| lock_bio_revoked | 指纹库已变更，请用 PIN 解锁后在设置里重新启用生物识别 | Biometric set changed. Unlock with PIN, then re-enable biometric in Settings. | — |
| lock_bio_failed | 生物识别失败：%1$s | Biometric failed: %1$s | err |
| lock_forgot_pin | 忘记 PIN？ | Forgot PIN? | — |
| lock_recovery_password_step | 输入 E2EE 密码 | Enter E2EE Password | — |
| lock_recovery_pin_step | 设置新 PIN | Set New PIN | — |
| lock_recovery_password_placeholder | E2EE 密码 | E2EE password | — |
| lock_recovery_new_pin_placeholder | 4 位数字新 PIN | 4-digit new PIN | — |
| lock_recovery_pin_invalid | 新 PIN 必须是 4 位数字 | New PIN must be 4 digits | — |
| lock_recovery_failed | 恢复失败：%1$s | Recovery failed: %1$s | err |

## search（~8 key）

| key | zh | en | placeholder |
|---|---|---|---|
| search_placeholder | 搜索资料、标注、正文… | Search resources, annotations, body… | — |
| search_cancel | 取消 | Cancel | — | (复用 common_cancel) |
| search_failed | 搜索失败：%1$s | Search failed: %1$s | err |
| search_empty_prompt | 输入关键字搜索 | Enter keywords to search | — |
| search_no_match | 没有匹配项 | No matches | — |
| search_match_label_highlights | 标注 | annotations | — |
| search_match_label_comments | 评论 | comments | — |
| search_match_label_title | 标题 | title | — |
| search_match_label_description | 摘要 | description | — |
| search_match_label_body | 正文 | body | — |
| search_match_suffix | %1$s 匹配 | matched %1$s | join |

## sidebar（Library + FolderDrawer，~6 key）

| key | zh | en | placeholder |
|---|---|---|---|
| sidebar_inbox | 收件箱 | Inbox | — |
| sidebar_all_resources | 所有资料 | All Resources | — |
| sidebar_folders_label | 文件夹 | Folders | — |
| sidebar_sync_now | 立即同步 | Sync Now | — | (复用 settings_sync_now) |
| sidebar_sync_in_progress | 同步中… | Syncing… | — | (复用 settings_sync_in_progress) |
| sidebar_sync_preparing | 准备中… | Preparing… | — | (复用 settings_sync_preparing) |
| sidebar_sync_complete | 同步完成 ↑%1$d ↓%2$d | Sync complete ↑%1$d ↓%2$d | u, d | (复用 settings_sync_complete) |
| sidebar_sync_skipped | 同步跳过 | Sync skipped | — |
| sidebar_sync_failed | 同步失败：%1$s | Sync failed: %1$s | err |

## resource_list（ResourceList + ResourceItem，~5 key）

| key | zh | en | placeholder |
|---|---|---|---|
| resource_list_empty | 当前文件夹没有资料 | No items in this folder | — |
| resource_list_empty_hint | (Phase 2 阶段暂无导入入口，等同步完成后再看) | (No import entry in Phase 2; check back after sync) | — |
| resource_list_error | err: %1$s | err: %1$s | err |
| resource_list_sync_failed | 同步失败：%1$s | Sync failed: %1$s | err | (复用 sidebar_sync_failed) |
| resource_item_no_title | (无标题) | (untitled) | — | (复用 common_no_title) |

## annotation（AnnotationPanel，~7 key）

| key | zh | en | placeholder |
|---|---|---|---|
| annotation_section_title | 标注 (%1$d) | Annotations (%1$d) | n |
| annotation_note_label | 笔记 | Note | — |
| annotation_note_add | + 笔记 | + Note | — |
| annotation_comment_add | + 评论 | + Comment | — |
| annotation_empty_hint | 长按页面文字创建高亮 | Long-press text to create a highlight | — |
| annotation_copy_link | 复制链接 | Copy Link | — |
| annotation_delete | 删除 | Delete | — | (复用 common_delete) |

## huks（HuksService，1 key）

| key | zh | en | placeholder |
|---|---|---|---|
| huks_auth_title | 验证身份以解锁拾贝 | Authenticate to unlock Shibei | — |

---

## 颜色 token 清单（Task 2 用）

扫描结果：~30 处 hex 颜色，归并为以下 token：

| token | base (light) | dark | 替换处 |
|---|---|---|---|
| `bg_primary` | `#FFFFFF` | `#1A1A1A` | start window |
| `bg_secondary` | `#F5F5F5` | `#0F0F0F` | drawer / list bg |
| `bg_button_neutral` | `#EEE` | `#2A2A2A` | Onboard 上一步按钮 |
| `text_primary` | `#222` | `#E8E8E8` | 主标题 |
| `text_secondary` | `#666` | `#A0A0A0` | scanInfo / 副文案 / button label on neutral |
| `text_tertiary` | `#888` | `#777` | hint / 4 处 |
| `text_subtle` | `#999` | `#666` | meta date / list empty |
| `text_disabled` | `#BBB` | `#555` | empty hint |
| `text_pagenum` | `#AAA` | `#666` | "1 / 4" 步骤号 |
| `accent_primary` | `#2B7DE9` | `#5B9DF9` | 启用按钮 |
| `accent_primary_alt` | `#007DFF` | `#5B9DF9` | 同步确认 |
| `accent_success` | `#2A77` (`#22AA77`) | `#3FBC8A` | sync summary 绿 |
| `accent_danger` | `#D33` | `#E55757` | error 文案 / 重置确认 |
| `accent_error_strong` | `#C00` | `#FF6B6B` | "init failed" / "err:" |
| `border_divider` | `#EEE` | `#333` | 列表 divider |
| `shadow_default` | `#40000000` | `#80000000` | selection palette shadow |
| `surface_tap_invisible` | `#01000000` | `#01FFFFFF` | 透明可点 hit area（保留） |

**例外（不替换）：**
- `HL_COLORS` 4 色（`#ffeb3b/#81c784/#64b5f6/#f48fb1`）—— 标注数据，桌面同色
- `sys.color.ohos_id_color_*` 系统资源 —— 已是主题感知
- `Color.Transparent` 等 ArkUI 枚举 —— 已是主题中性

---

## 实施顺序索引

落表写入资源文件的顺序（按 task 推进）：

1. **Task 1** —— 落 `common_*` 16 个 key（基础设施 smoke）
2. **Task 2** —— 落全部色板 token（一次落齐，后续 task 直接用）
3. **Task 3** —— 落 `settings_*` 50 个 key（最大头）
4. **Task 4** —— 落 `onboard_*` 30 个 key
5. **Task 5** —— 落 `reader_*` + `annotation_*` 共 23 个 key
6. **Task 6** —— 落 `lock_*` + `search_*` + `sidebar_*` + `resource_list_*` 共 39 个 key
7. **Task 7** —— 落 `huks_*` 1 个 key
8. **Task 8** —— PDF shell 不进 string.json，URL 参数注入 `common_loading`

**预计 zh + en 各 ~155 条 entry**（含复用，去重后约 130 条独立 zh 文案 + 130 条 en 文案）。

---

**清单完成。** 可进入 Task 1。
