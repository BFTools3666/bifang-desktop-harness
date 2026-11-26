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
