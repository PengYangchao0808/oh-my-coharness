import { readFileSync } from 'node:fs'
const buffer = readFileSync('C:/Users/彭扬超/AppData/Local/Programs/DeepSeek Harness/resources/app.asar')
const jsonStart = 16
const window = buffer.subarray(jsonStart, jsonStart + 8*1024*1024).toString('latin1')
let depth=0, inString=false, escaped=false, end=-1
for (let i=0;i<window.length;i+=1){const ch=window[i];if(inString){if(escaped)escaped=false;else if(ch==='\\\\')escaped=true;else if(ch==='\"')inString=false;continue}if(ch==='\"')inString=true;else if(ch==='{')depth+=1;else if(ch==='}'){depth-=1;if(depth===0){end=i+1;break}}}
const headerText = buffer.subarray(jsonStart, jsonStart+end).toString('utf8')
const header = JSON.parse(headerText)
const baseOffset = jsonStart + Buffer.byteLength(headerText)
function read(p){let node={files:header.files};for(const part of p.split('/')){if(!node.files||!node.files[part])return null;node=node.files[part]}if(!node.offset||node.size===undefined)return null;return buffer.subarray(baseOffset+Number(node.offset),baseOffset+Number(node.offset)+node.size).toString('utf8')}
const text = read('dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
const re = /request-error/g
let m, n=0
while ((m = re.exec(text)) && n < 6) { n+=1; const from=Math.max(0,m.index-500); console.log('=== @'+m.index+' ==='); console.log(text.slice(from, m.index+700)) }
console.log('MATCHES', n)