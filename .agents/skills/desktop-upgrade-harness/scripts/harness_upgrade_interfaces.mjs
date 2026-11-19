/** 只读解析升级所需接口事实，按框架阻断不适用的 GUI 工程候选。 */

import fs from "node:fs";
import path from "node:path";
import { UpgradeError, assertSafePath, lstatOrNull, snapshotFile } from "./harness_upgrade_safety.mjs";
import {
  assertNshWorkspacePin, equalPath, keyPath, readNshCargoApp, readNshMixedConfig, statements, stringValue, validateNshTargets,
} from "../../desktop-implement-change/scripts/nsh_runtime_policy.mjs";

const METADATA_TABLE = ["workspace", "metadata", "agent-first-harness"];
const INTERFACES = new Set(["cli", "mcp", "gui", "nsh"]);
const TAURI_SKILLS = new Set([
  "desktop-add-gui-adapter", "mantine-list-view", "desktop-add-gui-system-locale",
  "desktop-add-gui-window-state", "desktop-add-gui-dialog",
  "desktop-add-gui-system-tray", "desktop-add-gui-single-instance", "desktop-add-gui-deep-link",
  "desktop-add-gui-global-shortcut", "desktop-add-gui-system-notifications", "desktop-add-gui-autostart",
  "desktop-build-tauri-local-install", "desktop-build-tauri-release",
]);

/** 仅缺省框架沿用 Tauri；接口或框架重复、错位与非法类型均失败关闭。 */
export function parseInterfaceSelection(source) {
  let section = [];
  let metadataSections = 0;
  const values = new Map();
  for (const statement of statements(source)) {
    if (statement.startsWith("[")) {
      const array = statement.startsWith("[[");
      section = keyPath(statement.slice(array ? 2 : 1, array ? -2 : -1));
      if (equalPath(section, METADATA_TABLE)) {
        if (array || ++metadataSections > 1) throw new UpgradeError("Cargo Harness 接口元数据表重复或类型非法");
      }
      if (["gui-framework", "interfaces", "nsh-targets"].some((key) => equalPath(section, [...METADATA_TABLE, key]))) {
        throw new UpgradeError("Cargo 接口、框架与 NSH 目标必须是值，不能是表");
      }
      continue;
    }
    const separator = statement.indexOf("=");
    if (separator < 0) continue;
    const keys = keyPath(statement.slice(0, separator));
    const fullPath = keys && section ? [...section, ...keys] : null;
    const value = statement.slice(separator + 1).trim();
    for (const key of ["interfaces", "gui-framework", "nsh-targets"]) {
      const wanted = [...METADATA_TABLE, key];
      if (equalPath(fullPath, wanted)) {
        if (values.has(key)) throw new UpgradeError(`Cargo ${key} 元数据重复`);
        values.set(key, value);
      } else if (["gui-framework", "nsh-targets"].includes(key) && keys?.includes(key)) {
        throw new UpgradeError(`Cargo ${key} 必须位于 workspace.metadata.agent-first-harness`);
      } else if (fullPath && fullPath.length < wanted.length && fullPath.every((part, index) => part === wanted[index]) && value.startsWith("{")) {
        throw new UpgradeError("Cargo Harness 接口元数据须使用独立表或点分键，不能使用内联表");
      }
    }
  }
  let interfaces = [];
  if (values.has("interfaces")) {
    const value = values.get("interfaces");
    if (!value.startsWith("[") || !value.endsWith("]")) throw new UpgradeError("Cargo interfaces 必须是字符串数组");
    const members = value.slice(1, -1).trim().replace(/,\s*$/u, "");
    interfaces = members ? members.split(",").map((member) => stringValue(member.trim(), "interfaces")) : [];
    if (interfaces.some((item) => !INTERFACES.has(item)) || new Set(interfaces).size !== interfaces.length) {
      throw new UpgradeError("Cargo interfaces 包含未知或重复接口");
    }
  }
  const framework = values.has("gui-framework") ? stringValue(values.get("gui-framework"), "gui-framework") : "tauri";
  if (framework !== "tauri") throw new UpgradeError('Cargo gui-framework 无效。DESKTOP 仅支持 Tauri，NSH 使用顶层 interfaces = ["nsh"]');
  if (values.has("gui-framework") && !interfaces.includes("gui")) throw new UpgradeError("Cargo gui-framework 只适用于已选择 GUI 的下游");
  if (interfaces.includes("nsh")) {
    if (interfaces.length !== 1 || values.has("gui-framework")) throw new UpgradeError("Cargo NSH 当前必须是独立顶层接口，不能同时声明 GUI 框架");
    const raw = values.get("nsh-targets");
    if (!raw?.startsWith("[") || !raw.endsWith("]")) throw new UpgradeError("Cargo nsh-targets 必须是非空字符串数组");
    const members = raw.slice(1, -1).trim().replace(/,\s*$/u, "");
    const nshTargets = members ? members.split(",").map((member) => stringValue(member.trim(), "nsh-targets")) : [];
    try { validateNshTargets(nshTargets); }
    catch { throw new UpgradeError("Cargo nsh-targets 必须非空且只包含受支持的唯一目标"); }
    assertNshWorkspacePin(source);
    return { interfaces, guiFramework: null, nshTargets };
  }
  if (values.has("nsh-targets")) throw new UpgradeError("Cargo nsh-targets 只适用于顶层 NSH 接口");
  return { interfaces, guiFramework: interfaces.includes("gui") ? framework : null };
}

/** 缺少 Cargo 的既有工程不推断 GUI；现有清单必须是安全的普通文件。 */
export function readInterfaceSelection(root) {
  const file = assertSafePath(root, path.join(root, "Cargo.toml"), "目标接口清单", { finalMayBeMissing: true });
  const stat = lstatOrNull(file);
  if (stat === null) return { interfaces: [], guiFramework: null, manifestSnapshot: null };
  if (!stat.isFile()) throw new UpgradeError("目标 Cargo.toml 必须是普通文件");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  const selection = parseInterfaceSelection(source);
  if (selection.interfaces.includes("nsh")) {
    try { readNshMixedConfig(path.dirname(readNshCargoApp(root).manifest_path)); }
    catch (error) { throw new UpgradeError(error.message); }
  }
  return { ...selection, manifestSnapshot: snapshotFile(file) };
}

/** 识别不能继续传播或登记为 Harness 所有的退役工程路径。 */
export function isRetiredInterfaceAsset(relative) {
  return /^\.agents\/skills\/(?:desktop-add-tui-adapter|desktop-[^/]*-gpui-[^/]+|gpui-kit(?:-design-guides)?)(?:\/|$)/u.test(relative)
      || [
        "docs/design_standards/gpui_gui.md",
        ".agents/skills/desktop-check-development-environment/scripts/linux-gpui-dependencies.sh",
        ".agents/skills/desktop-check-development-environment/scripts/linux_gpui_dependencies.test.mjs",
        ".agents/skills/desktop-initialize-rust-project/assets/vendor/gpui-kit-skills",
        ".agents/skills/desktop-initialize-rust-project/references/gpui-initialization.md",
        ".agents/skills/desktop-initialize-rust-project/scripts/ensure_gpui_kit_skills.mjs",
        ".agents/skills/desktop-initialize-rust-project/scripts/ensure_gpui_kit_skills.test.mjs",
        ".agents/skills/desktop-upgrade-harness/references/gpui-ownership.md",
        ".agents/skills/desktop-add-nsh-adapter/scripts/run_nsh_tui.mjs",
        ".agents/skills/desktop-add-nsh-adapter/scripts/nsh_tui_adapter.test.mjs",
      ].some(asset => relative === asset || relative.startsWith(`${asset}/`));
}

/** 接口条件资产仅按受保护 Cargo 选择适用，不能由候选目录反向决定框架。 */
export function inapplicableGuiCandidate(relative, selection) {
  const nsh = selection.interfaces.includes("nsh");
  const nshDesktop = nsh && selection.nshTargets.includes("desktop");
  const desktopGraphics = selection.interfaces.includes("gui") || nshDesktop;
  const cli = selection.interfaces.includes("cli");
  if (relative === "docs/CLI_CONTRACT.md") return !cli;
  if (relative === "docs/GUI_ENGINEERING.md") return !(selection.interfaces.includes("gui") || nsh);
  const skill = /^\.agents\/skills\/([^/]+)(?:\/|$)/u.exec(relative)?.[1];
  if (["desktop-add-cli-adapter", "desktop-build-rust-release", "desktop-prepare-cross-platform-release"].includes(skill)) return !cli;
  if (skill === "desktop-add-mcp-adapter") return !selection.interfaces.includes("mcp");
  if (skill === "desktop-extract-i18n-strings") return selection.guiFramework !== "tauri";
  if (skill === "desktop-collect-release-artifacts") return !(cli || selection.guiFramework === "tauri");
  if (["desktop-add-nsh-adapter", "desktop-build-nsh-release", "desktop-test-nsh-initialization-e2e", "nsh", "nsh-design-guides"].includes(skill)) return !nsh;
  if (skill === "desktop-prepare-gui-support-surfaces") return !(selection.guiFramework === "tauri" || nshDesktop);
  if (TAURI_SKILLS.has(skill)) return selection.guiFramework !== "tauri";
  if (skill === "desktop-prepare-gui-app-identity") return !desktopGraphics;
  return false;
}
