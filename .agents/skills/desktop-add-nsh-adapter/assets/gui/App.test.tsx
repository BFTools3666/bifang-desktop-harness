import { expect, open, test } from "nsh/test";

test("mixed UI reads the shared Rust core and saves language and theme", async () => {
  const app = await open(".", { locale: "en-US" });
  await app.waitFor("Neutral workspace initialized. Define the product in this downstream project.");
  await app.press("Settings");
  await app.press("Dark");
  expect(app.storage().appearance).toBe("dark");
  await app.press("中文");
  await app.waitFor("外观主题");
  expect(app.storage()["interface-language"]).toBe("zh");
  await app.press("首页");
  expect(app.texts()).toContain("中性工程已初始化，请在下游定义产品。");
});

test("official i18n falls back to English and restores a saved language", async () => {
  const fallback = await open(".", { locale: "fr-FR" });
  await fallback.waitFor("Home");
  const saved = await open(".", { locale: "en-US", storage: { "interface-language": "zh" } });
  await saved.waitFor("首页");
  await saved.press("设置");
  await saved.waitFor("外观主题");
});
