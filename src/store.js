import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const key = path.join(dir, "key");
    if (!fs.existsSync(key))
      fs.writeFileSync(key, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = fs.readFileSync(key);
    this.file = path.join(dir, "state.json");
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { accounts: {}, interval: 60, bridgeToken: null };
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  encrypt(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data]
      .map((b) => b.toString("base64"))
      .join(".");
  }
  decrypt(value) {
    if (!value) return "";
    const [iv, tag, data] = value
      .split(".")
      .map((s) => Buffer.from(s, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  }
}
