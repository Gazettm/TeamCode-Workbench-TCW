import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Explicit loopback URL only. This script creates test records; use an isolated instance.
const base = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(base ?? '')) {
  throw new Error('Specify the isolated loopback API, e.g. http://127.0.0.1:18082');
}
const suffix = randomBytes(5).toString('hex');
const password = randomBytes(18).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => {
  assert.match(value, /^[0-9a-f-]{36}$/);
  return value;
};
let checks = 0;
async function call(method, path, status, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + '/api' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000)
  });
  const result = response.status === 204 ? null : await response.json();
  assert.equal(response.status, status, method + ' ' + path + ' returned ' + response.status + ' (' + (result?.code ?? 'no code') + ')');
  if (status >= 400) assert.equal(typeof result.code, 'string');
  checks++;
  return result;
}
async function register(prefix) {
  const username = prefix + suffix;
  const info = { username, password, displayName: '联调 ' + prefix };
  const { user } = await call('POST', '/auth/register', 201, null, info);
  assert.equal(user.username, username);
  const session = await call('POST', '/auth/login', 200, null, { username, password });
  assert.equal(session.user.id, user.id);
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  return session;
}
assert.equal((await call('GET','/health',200)).status, 'ready');
await call('GET','/projects',401);
const owner = await register('leader');
const member = await register('member');
const outsider = await register('outsider');
await call('POST','/auth/register',409,null,{ username: owner.user.username.toUpperCase(), displayName: '重复账号', password });
await call('POST','/auth/login',401,null,{ username: owner.user.username, password: 'wrong-password' });
assert.equal((await call('GET','/me',200,owner.token)).id, owner.user.id);

const first = await call('POST','/projects',201,owner.token,{name:'协作联调一 ' + suffix});
const second = await call('POST','/projects',201,owner.token,{name:'私有项目二 ' + suffix});
assert.equal(first.role, 'OWNER');
assert.deepEqual(new Set((await call('GET','/projects',200,owner.token)).map(p => p.id)), new Set([first.id,second.id]));
const one = '/projects/' + first.id;
const two = '/projects/' + second.id;
await call('GET',one,404,outsider.token);
await call('GET',one+'/members',404,member.token);
await call('POST',one+'/invitations',404,outsider.token,{validHours:24});
assert.deepEqual(await call('GET','/projects',200,member.token),[]);
await call('POST',one+'/invitations',400,owner.token,{validHours:0});
const invitation = await call('POST',one+'/invitations',201,owner.token,{validHours:24});
assert.match(invitation.code,/^[A-Za-z0-9_-]{24}$/);
const invitationList = await call('GET',one+'/invitations',200,owner.token);
assert.ok(invitationList.some(i => i.id === invitation.id));
assert.ok(!JSON.stringify(invitationList).includes(invitation.code));

const joined = await Promise.all([0,1].map(() => call('POST','/invitations/join',200,member.token,{code:invitation.code})));
assert.ok(joined.every(j => j.role === 'MEMBER' && j.id === first.id));
const roster = await call('GET',one+'/members',200,member.token);
assert.deepEqual(new Set(roster.map(m => m.id)),new Set([owner.user.id,member.user.id]));
assert.equal(roster.length,2);
assert.equal((await call('POST','/invitations/join',200,owner.token,{code:invitation.code})).role,'OWNER');
await call('POST',one+'/invitations',403,member.token,{validHours:24});
await call('GET',one+'/invitations',403,member.token);
await call('DELETE',one+'/invitations/'+invitation.id,403,member.token);
await call('GET',two+'/members',404,member.token);
assert.deepEqual((await call('GET','/projects',200,member.token)).map(p=>p.id),[first.id]);
await call('DELETE',two+'/invitations/'+invitation.id,404,owner.token);
await call('DELETE',one+'/invitations/'+invitation.id,204,owner.token);
await call('DELETE',one+'/invitations/'+invitation.id,204,owner.token);
await call('POST','/invitations/join',400,outsider.token,{code:invitation.code});
assert.equal((await call('GET',one+'/members',200,member.token)).length,2);

if (process.env.TCW_E2E_MYSQL && process.env.TCW_E2E_DB_INI) {
  // Optional database verification. Pass only the option file of the isolated
  // test database. Update only rows belonging to this run.
  const sql = statement => {
    const result = spawnSync(process.env.TCW_E2E_MYSQL,
      ['--defaults-file='+process.env.TCW_E2E_DB_INI,'--database=tcw','--batch','--skip-column-names','--execute',statement],
      { windowsHide:true, encoding:'utf8', timeout:5000 });
    assert.equal(result.status,0,'Test MySQL verification failed');
    return result.stdout.trim();
  };
  const toExpire = await call('POST',one+'/invitations',201,owner.token,{validHours:24});
  const stored = sql("SELECT COUNT(*) FROM app_users WHERE id='"+uuid(owner.user.id)+"' AND password_hash LIKE '$2%'");
  assert.equal(stored,'1');
  assert.equal(sql("SELECT COUNT(*) FROM auth_sessions WHERE token_hash='"+hash(owner.token)+"'"),'1');
  assert.equal(sql("SELECT COUNT(*) FROM project_invitations WHERE code_hash='"+hash(toExpire.code)+"'"),'1');
  sql("UPDATE project_invitations SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE id='"+uuid(toExpire.id)+"'");
  await call('POST','/invitations/join',400,outsider.token,{code:toExpire.code});
  sql("UPDATE auth_sessions SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 MINUTE WHERE token_hash='"+hash(outsider.token)+"'");
  await call('GET','/projects',401,outsider.token);
  console.log('MySQL checks passed: hashed values, invite expiry and session expiry.');
}
await call('POST','/auth/logout',204,member.token);
await call('GET','/me',401,member.token);
await call('POST','/auth/logout',204,owner.token);
console.log('API integration passed: '+checks+' HTTP checks (real MySQL).');
