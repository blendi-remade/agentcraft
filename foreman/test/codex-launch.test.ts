import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { codexCommand } from '../src/agents/codex/launch.js';
import {tempDir,rmrf} from './helpers.js';
const homes:string[]=[];
afterEach(()=>homes.splice(0).forEach(rmrf));
it('keeps native executables as direct argv',()=>{
 expect(codexCommand('/bin/codex',['mcp','list'],'darwin')).toEqual({command:'/bin/codex',args:['mcp','list']});
 expect(codexCommand('C:\\Tools\\codex.exe',['login','status'],'win32')).toEqual({command:'C:\\Tools\\codex.exe',args:['login','status']});
});
it('runs the Windows npm entry with Node and preserves JSON, spaces and shell metacharacters literally',()=>{
 const home=tempDir('codex launch ');homes.push(home);
 const script=path.join(home,'node_modules','@openai','codex','bin','codex.js');fs.mkdirSync(path.dirname(script),{recursive:true});
 fs.writeFileSync(script,'console.log(JSON.stringify(process.argv.slice(2)))');
 const args=['app-server','-c','mcp_servers={"a"={command="C:\\Program Files\\app.exe",enabled=false}}','a & b | %PATH% !x! ^test','literal "quote"'];
 const invocation=codexCommand(path.join(home,'codex.cmd'),args,'win32');
 expect(invocation.command).toBe(process.execPath);
 expect(JSON.parse(execFileSync(invocation.command,invocation.args,{encoding:'utf8'}))).toEqual(args);
});
it('supports an explicit npm JavaScript entry and rejects unresolved batch shims',()=>{
 expect(codexCommand('/tools/codex.js',['login','status'],'win32')).toEqual({command:process.execPath,args:['/tools/codex.js','login','status']});
 const home=tempDir();homes.push(home);
 expect(()=>codexCommand(path.join(home,'codex.cmd'),[],'win32')).toThrow('codex.exe');
});
