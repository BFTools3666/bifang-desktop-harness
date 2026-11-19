import { NSH_STABLE_REVISION, validateNshTargets } from '../../desktop-implement-change/scripts/nsh_runtime_policy.mjs';
export {
  NSH_STABLE_VERSION, NSH_STABLE_REVISION, NSH_OFFICIAL_GIT, NSH_TARGETS,
  NSH_PLATFORMS, NSH_TARGET_PLATFORMS, validateNshPlatforms,
} from '../../desktop-implement-change/scripts/nsh_runtime_policy.mjs';

/** 同一身份限制用于表单和直接生成。展示名也会作为官方包的文件名。 */
export function validNshIdentity(field, value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f\u2028\u2029]/u.test(value)) return false;
  if (field === 'projectId') return value.length <= 64 && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(value);
  if (field === 'owner') return value.length <= 200;
  const filename = value.split('.')[0];
  return value.length <= 200 && Buffer.byteLength(value) <= 240 &&
    !/[\\/:*?"<>|]/u.test(value) && !value.endsWith('.') && !value.startsWith('-') &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu.test(filename);
}

/** 校验受支持能力集合，并返回唯一正式工具链提交。 */
export function nshRevisionForTargets(targets) {
  validateNshTargets(targets);
  return NSH_STABLE_REVISION;
}
