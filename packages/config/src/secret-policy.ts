import {createHash} from 'node:crypto';
const exposed=new Set(["8f6cdb6c83909ed24227d7f91c7df42ea1b0ac19b4c5785ed10bafaaf52f5ce0", "a72748c9b78287396feabd7b52e916adaf643205366a215fb384da3938ee078e", "8ba4b7632189bc7090bdac2c6eaa2461611a2f06e6fef235a84b8aec1df0114c", "6ca83150acd13ec88a86edf78dbf799fc608e5819c98dd8c0f7134930239d8b4", "6f2cb9dd8f4b65e24e1c3f3fa5bc57982349237f11abceacd45bbcb74d621c25", "df5ba79c07b19662dd59a40631be1d0910003bf7e7c6f5c92189f83c52e89fdc"]);
const exposedSecret=(v:string)=>exposed.has(createHash('sha256').update(v).digest('hex'));
/** Pure validation: never include supplied credentials in diagnostics. */
export function strongSecret(value: string): boolean {
  return !exposedSecret(value) && value.length >= 32 && new Set(value).size >= 10 &&
    !/change.?me|replace|example|placeholder|development|dev[_-]|fixture|test[_-]|removed_exposed/i.test(value);
}
export function validDatabaseCredential(raw: string): boolean {
  try {
    const url = new URL(raw);
    const password = decodeURIComponent(url.password);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && !!url.username && !!url.hostname &&
      !exposedSecret(password) && password.length >= 16 && new Set(password).size >= 8 &&
      !/change.?me|replace|example|placeholder|dev[_-]|fixture|removed_exposed/i.test(password);
  } catch { return false; }
}
