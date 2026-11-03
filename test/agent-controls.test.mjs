import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Model UI controls the selected pane and agent launch uses the exact commands in new panes', {timeout:30000}, async t => {
  const dir=mkdtempSync(join(tmpdir(),'herdr-agent-controls-'));
  const creds=join(dir,'credentials.json');writeFileSync(creds,JSON.stringify({browserPassword:'test',clientToken:'test'}));
  const server=spawn(process.execPath,['relay.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',CREDENTIALS_FILE:creds}});
  let logs='',browser;server.stdout.on('data',b=>logs+=b);
  t.after(async()=>{await browser?.close();server.kill();await Promise.race([once(server,'exit'),delay(1000)]);rmSync(dir,{recursive:true,force:true});});
  for(let i=0;i<100&&!/listening on (\d+)/.test(logs);i++)await delay(50);
  const base=`http://127.0.0.1:${/listening on (\d+)/.exec(logs)[1]}`;
  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const commands=[],panes=[{id:'p1',title:'Devin',agent:'devin',status:'working'}];let menu=false,selected=0;
  await page.route('**/api/**',route=>route.fulfill({json:{clients:[{id:'test',label:'Test',online:true,mobile:true,mobileVersion:2}]}}));
  await page.routeWebSocket('**/terminal?*',ws=>ws.onMessage(raw=>{
    const m=JSON.parse(raw);if(m.type!=='mobile')return;commands.push(m);
    let result={};
    if(m.operation==='panes')result={panes};
    if(m.operation==='prompt'&&m.params.text==='/model')menu=true;
    if(m.operation==='key'){
      if(m.params.key==='down')selected=1;
      if(m.params.key==='up')selected=0;
      if(['enter','esc'].includes(m.params.key))menu=false;
    }
    if(m.operation==='read')result=m.params.view==='menu'?{view:'menu',text:menu?`/ Type to search\n${selected===0?'❭':' '} Adaptive\n${selected===1?'❭':' '} Grok\n↑↓ select · ←→ reasoning effort · ↵ confirm · esc cancel`:'Ready'}:{text:'Ready'};
    if(m.operation==='create'){const id='p'+(panes.length+1);panes.push({id,title:m.params.label,status:'unknown'});result={paneId:id,created:true};}
    ws.send(JSON.stringify({type:'mobile',requestId:m.requestId,result}));
  }));
  await page.goto(base);await page.locator('#connect').click();await page.locator('.pane-card').waitFor();
  await page.locator('#prompt').fill('Unsent draft');
  assert.equal(await page.locator('#modelButton').isEnabled(),true, 'Working status must not disable Model');
  await page.locator('#modelButton').click();await page.locator('#modelOptions button').nth(1).click();
  await page.waitForFunction(()=>document.querySelector('#modelOptions button[aria-pressed=true]')?.textContent==='Grok');
  await page.locator('[data-model-key=enter]').click();await page.waitForFunction(()=>document.querySelector('#modelStatus').textContent.includes('選單已結束'));
  await page.locator('#closeModel').click();
  assert.equal(await page.locator('#prompt').inputValue(),'Unsent draft');
  assert.deepEqual(commands.filter(m=>m.operation==='prompt').map(m=>m.params),[{paneId:'p1',text:'/model'}]);
  assert.deepEqual(commands.filter(m=>m.operation==='key').map(m=>m.params),[{paneId:'p1',key:'down'},{paneId:'p1',key:'enter'}]);
  await page.locator('#prompt').fill('/model');
  await page.locator('#sendPrompt').click();
  await page.locator('#modelOptions button').first().waitFor();
  await page.waitForFunction(()=>document.querySelector('#prompt').value==='');
  await page.locator('#closeModel').click();
  await page.waitForFunction(()=>!document.querySelector('#modelDialog').open);
  assert.equal(commands.filter(m=>m.operation==='prompt'&&m.params.text==='/model').length,2);
  for(const [agent,command] of Object.entries({devin:'devin',codex:'codex --dangerously-bypass-approvals-and-sandbox',claude:'claude --allow-dangerously-skip-permissions'})){
    await page.locator('#launchAgent').click();await page.locator('#agentCommand').selectOption(agent);await page.locator('#submitCreate').click();
    await page.waitForFunction(()=>!document.querySelector('#createDialog').open);
    const sent=commands.filter(m=>m.operation==='prompt').at(-1);
    assert.equal(sent.params.text,command);assert.equal(sent.params.paneId,panes.at(-1).id);assert.notEqual(sent.params.paneId,'p1');
  }
  assert.deepEqual(errors,[]);
});
