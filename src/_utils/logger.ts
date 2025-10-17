import fs from "fs";
import path from "path";

//TODO: Implement a more advanced logging mechanism if needed
export function logger(message: string) {
  const logPath = path.resolve(__dirname, "../../root.log");
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
}
