import fs from "node:fs";
const databaseId = process.env.D1_DATABASE_ID;
if (!databaseId) throw new Error("D1_DATABASE_ID is required");
const config = JSON.parse(fs.readFileSync("wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, ""));
config.d1_databases = [{ binding: "DB", database_name: "marketlab-db", database_id: databaseId }];
fs.writeFileSync("wrangler.deploy.json", JSON.stringify(config, null, 2));
