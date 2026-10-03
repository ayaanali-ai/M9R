import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { personLabel } from "../src/lib/rooms/person-names";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

test("a person is called by profile name, then username, then the start of their email, never an id", () => {
  assert.equal(personLabel({ name: "John Smith", username: "js", email: "kaliayaan@gmail.com" }), "John Smith");
  assert.equal(personLabel({ name: " ", username: "ayaan", email: "a@b.com" }), "ayaan");
  assert.equal(personLabel({ name: null, username: null, email: "kainaatay99@gmail.com" }), "kainaatay99");
  assert.equal(personLabel({}), null);
});

test("rooms show people by name: no 'Member xxxxxx' or 'Guest xxxxxxxx' id fragments are built in the room page or routes", () => {
  const page = read("src/app/rooms/[roomId]/page.tsx");
  const members = read("src/app/api/rooms/[roomId]/members/route.ts");
  assert.doesNotMatch(page, /Guest \{m\.userId/, "pending requests show a name");
  assert.doesNotMatch(page, /`Member \$\{String\(event\.actor_user_id/, "activity shows a name");
  assert.doesNotMatch(members, /`Member \$\{member\.id/, "the members list shows a name");
  assert.match(members, /personNames\(/);
  assert.match(read("src/app/api/rooms/[roomId]/pending/route.ts"), /personNames\(/);
});
