import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { gitVersion } from "../src/version/index.ts";

test("gitVersion reads the checked-out commit", () => {
  const v = gitVersion()!;
  assert.match(v.commit, /^[0-9a-f]{40}$/);
  assert.equal(v.short, v.commit.slice(0, 7));
  assert.ok(!Number.isNaN(Date.parse(v.built)));
});

test("outside a git checkout it says so", () => {
  assert.equal(gitVersion(tmpdir()), undefined);
});
