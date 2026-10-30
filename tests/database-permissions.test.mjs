import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const db = new PGlite();
async function migration(name) {
  const sql = await readFile(new URL(`../neon/${name}`, import.meta.url), "utf8");
  await db.exec(sql.replaceAll("create extension if not exists pgcrypto;", ""));
}

before(async () => {
  for (const name of ["001_app_schema.sql", "002_phone_auth.sql", "005_skm_seamless_wallet.sql",
    "006_game_display_settings.sql", "007_game_hot_setting.sql", "008_deposit_wagering.sql",
    "009_auth_security.sql", "010_money_constraints.sql", "011_runtime_role.sql", "012_game_minor_units.sql"]) await migration(name);
});
after(async () => { await db.close(); });

test("runtime role has no owner-like attributes or inherited memberships", async () => {
  const { rows } = await db.query("select rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,rolcanlogin from pg_roles where rolname='j777_runtime'");
  assert.deepEqual(rows[0], { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolbypassrls: false, rolcanlogin: true });
  assert.equal((await db.query("select count(*)::int as count from pg_auth_members m join pg_roles r on r.oid=m.member where r.rolname='j777_runtime'")).rows[0].count, 0);
});

test("rerunning the role migration does not rotate its active password", async () => {
  const before = (await db.query("select rolpassword from pg_authid where rolname='j777_runtime'")).rows[0].rolpassword;
  await migration("011_runtime_role.sql");
  const after = (await db.query("select rolpassword from pg_authid where rolname='j777_runtime'")).rows[0].rolpassword;
  assert.equal(after, before);
});

test("role hardening refuses an existing object owner rather than claiming to restrict owner powers", async () => {
  const owner = (await db.query("select current_user as name")).rows[0].name;
  await db.exec("create table public.runtime_owned_test(id integer); alter table public.runtime_owned_test owner to j777_runtime");
  try {
    await assert.rejects(() => migration("011_runtime_role.sql"), /object ownership/);
  } finally {
    await db.exec("rollback");
    await db.exec(`alter table public.runtime_owned_test owner to "${owner.replaceAll('"', '""')}"; drop table public.runtime_owned_test`);
  }
});

test("runtime can perform required app writes, but cannot drop/create tables or delete players", async () => {
  await db.exec("set role j777_runtime");
  try {
    const profile = await db.query("insert into public.profiles(phone) values ('+959123456789') returning id");
    const userId = profile.rows[0].id;
    await db.query("insert into public.auth_credentials(user_id,password_hash) values($1::uuid,'test-hash')", [userId]);
    await db.query("insert into public.auth_rate_limits(scope,key_hash,attempts,expires_at) values('test',$1,1,now()+interval '1 minute')", ["a".repeat(64)]);
    await db.query("insert into public.wallet_wagering_events(user_id,kind,amount,source_id,state) values($1::uuid,'DEPOSIT',1000,'role-test','SETTLED')", [userId]);
    assert.equal((await db.query("select count(*)::int as count from public.wallet_wagering_events")).rows[0].count, 1);
    for (const sql of ["delete from public.profiles", "drop table public.profiles", "create table public.unauthorized_table(id integer)"]) {
      await assert.rejects(() => db.query(sql), (error) => error.code === "42501");
    }
  } finally { await db.exec("reset role"); }
});

test("an unrelated role cannot read player credentials or balances through PUBLIC grants", async () => {
  await db.exec("create role security_unrelated_test nologin; set role security_unrelated_test");
  try {
    for (const table of ["profiles", "auth_credentials", "auth_sessions", "auth_admin_sessions", "auth_rate_limits", "wallet_wagering_events"]) {
      await assert.rejects(() => db.query(`select * from public.${table}`), (error) => error.code === "42501");
    }
  } finally { await db.exec("reset role"); }
});
