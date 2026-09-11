import { createClient } from "@supabase/supabase-js";
import fs from "fs";
const env = fs.readFileSync(".env.local", "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
const url = get("NEXT_PUBLIC_SUPABASE_URL");
const serviceKey = get("SUPABASE_SERVICE_ROLE_KEY");
const email = "tysonali989@gmail.com";
const supabase = createClient(url, serviceKey);
const { data, error } = await supabase.auth.admin.generateLink({ type: "magiclink", email });
if (error) { console.error(error); process.exit(1); }
console.log(JSON.stringify({ token_hash: data.properties.hashed_token }));
