const { OpenAI } = require('openai');
const config = require('./config');
const githubApi = require('./githubApi');
const cveApi = require('./cveApi');
const nistApi = require('./nistApi');
const docsApi = require('./docsApi');
const tutorialsApi = require('./tutorialsApi');
const exploitsApi = require('./exploitsApi');
const sandbox = require('./sandbox');
const imageApi = require('./imageApi');
const imageQuota = require('./imageQuota');
const whatsappApi = require('./whatsappApi');
const { logAudit } = require('./audit');
const { AUTO_CHAT_SKIP_TOKEN } = require('./autoChatConstants');

const openai = new OpenAI({ apiKey: config.openaiApiKey });
const str = { type: 'string' };
const tools = [
  ['github_searchRepos','Search GitHub repositories',{query:str}],
  ['github_searchCode','Search GitHub code',{query:str}],
  ['cve_search','Search NVD CVE records',{query:str}],
  ['cve_getById','Get one NVD CVE record',{cveId:str}],
  ['nist_search','Search NIST CSRC publications',{query:str}],
  ['nist_getDocument','Fetch an official NIST CSRC document page',{url:str}],
  ['docs_search','Search MDN Web Docs',{query:str}],
  ['research_search','Search security research references on GitHub',{query:str}],
  ['research_getReference','Fetch a GitHub security research reference',{identifier:str}],
  ['tutorials_search','Search programming/security learning material',{query:str}],
  ['runtime_execute','Run Python or JavaScript in the configured isolated runtime',{code:str,language:{type:'string',enum:['python','javascript']}}],
  ['images_generate','Generate an image or diagram',{prompt:str}],
  ['whatsapp_getGroups','List groups for a linked WhatsApp connection',{connectionId:str}],
  ['whatsapp_getGroupMetadata','Get group metadata',{connectionId:str,jid:str}],
  ['whatsapp_sendMessage','Send a WhatsApp message',{connectionId:str,jid:str,text:str}],
  ['whatsapp_mention','Mention a WhatsApp participant in a group',{connectionId:str,jid:str,text:str,participant:str}],
  ['whatsapp_pinMessage','Attempt to pin a WhatsApp message when the integration supports it',{connectionId:str,jid:str,messageId:str}],
  ['whatsapp_removeParticipant','Remove a participant from a WhatsApp group when the bot has permission',{connectionId:str,jid:str,participant:str}],
  ['whatsapp_addParticipant','Add/invite a participant to a WhatsApp group when the bot has permission',{connectionId:str,jid:str,participant:str}],
  ['whatsapp_promoteParticipant','Make a WhatsApp group participant an admin (owner-only action)',{connectionId:str,jid:str,participant:str}],
  ['whatsapp_demoteParticipant','Remove admin rights from a WhatsApp group participant (owner-only action)',{connectionId:str,jid:str,participant:str}],
  ['whatsapp_updateGroupSubject','Rename a WhatsApp group (owner-only action)',{connectionId:str,jid:str,subject:str}],
  ['whatsapp_updateGroupDescription','Change a WhatsApp group description (owner-only action)',{connectionId:str,jid:str,description:str}],
  ['whatsapp_updateGroupSetting','Change who can send messages or edit group info: announcement, not_announcement, locked, unlocked (owner-only action)',{connectionId:str,jid:str,setting:str}],
  ['whatsapp_leaveGroup','Leave a WhatsApp group entirely (owner-only action, irreversible)',{connectionId:str,jid:str}],
  ['whatsapp_createGroup','Create a new WhatsApp group (owner-only action)',{connectionId:str,subject:str,participants:{type:'array',items:str}}],
  ['whatsapp_getGroupInviteCode','Get the current WhatsApp group invite link (owner-only action)',{connectionId:str,jid:str}],
  ['whatsapp_revokeGroupInvite','Revoke and regenerate a WhatsApp group invite link, invalidating the old one (owner-only action)',{connectionId:str,jid:str}],
  ['whatsapp_blockContact','Block a WhatsApp contact (owner-only action)',{connectionId:str,jid:str}],
  ['whatsapp_unblockContact','Unblock a WhatsApp contact (owner-only action)',{connectionId:str,jid:str}],
  ['whatsapp_archiveChat','Archive or unarchive a WhatsApp chat (owner-only action)',{connectionId:str,jid:str,archive:{type:'boolean'}}],
  ['whatsapp_muteChat','Mute a WhatsApp chat for N hours, or unmute with 0 (owner-only action)',{connectionId:str,jid:str,muteHours:{type:'number'}}],
  ['whatsapp_pinChat','Pin or unpin a WhatsApp chat in the chat list (owner-only action)',{connectionId:str,jid:str,pin:{type:'boolean'}}],
  ['whatsapp_deleteMessage','Delete a WhatsApp message for everyone (owner-only action, irreversible)',{connectionId:str,jid:str,messageKey:{type:'object'}}],
  ['whatsapp_updateProfileStatus','Change the linked WhatsApp account\'s About/status text (owner-only action)',{connectionId:str,status:str}],
  ['whatsapp_getProfilePicture','Get the profile picture URL for a WhatsApp contact or group',{connectionId:str,jid:str}]
].map(([name,description,properties])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required:Object.keys(properties)}}}));

async function callTool(name,args,ctx){
  // Owner-level WhatsApp actions (group admin, contacts, chat state, profile)
  // may only be triggered by the account owner's own Note-to-Self message —
  // see session.js/messageRouter.js for how isOwnerMessage is derived.
  // Non-WhatsApp callers (web chat) are unaffected. Every owner action that
  // actually runs is written to the audit log (who/what/when).
  const ownerActionFromWeb = ctx.transport !== 'whatsapp';
  const unauthorized = () => ownerActionFromWeb || !ctx.isOwnerMessage;
  async function runOwnerAction(actionName, target, fn) {
    if (unauthorized()) {
      return { error: ownerActionFromWeb
        ? 'Unauthorized: owner-only WhatsApp actions must be requested from the linked account owner’s Note-to-Self chat.'
        : 'Unauthorized: this is an owner-only action. Message it from your own Note-to-Self chat to authorize it.' };
    }
    const result = await fn();
    logAudit(ctx.userId, actionName, target, result);
    return result;
  }

  switch(name){
    case 'github_searchRepos': return githubApi.searchRepos(args.query);
    case 'github_searchCode': return githubApi.searchCode(args.query);
    case 'cve_search': return cveApi.searchCve(args.query);
    case 'cve_getById': return cveApi.getCveById(args.cveId);
    case 'nist_search': return nistApi.searchNist(args.query);
    case 'nist_getDocument': return nistApi.getNistDocument(args.url);
    case 'docs_search': return docsApi.searchDocs(args.query);
    case 'research_search': return exploitsApi.searchExploits(args.query);
    case 'research_getReference': return exploitsApi.getExploitReference(args.identifier);
    case 'tutorials_search': return tutorialsApi.searchTutorials(args.query);
    case 'runtime_execute': return sandbox.executeCode(args.code,args.language);
    case 'images_generate': {
      const quota = imageQuota.checkAndConsume(ctx.userId);
      if (!quota.allowed) return { status: 'rate_limited', error: quota.error };
      return imageApi.generateImage(args.prompt);
    }
    case 'whatsapp_getGroups': return whatsappApi.getGroups(ctx.userId,args.connectionId);
    case 'whatsapp_getGroupMetadata': return whatsappApi.getGroupMetadata(ctx.userId,args.connectionId,args.jid);
    case 'whatsapp_sendMessage': return whatsappApi.sendMessage(ctx.userId,args.connectionId,args.jid,args.text);
    case 'whatsapp_mention': return whatsappApi.mention(ctx.userId,args.connectionId,args.jid,args.text,args.participant);
    case 'whatsapp_pinMessage': return whatsappApi.pinMessage(ctx.userId,args.connectionId,args.jid,args.messageId);
    case 'whatsapp_getProfilePicture': return whatsappApi.getProfilePictureUrl(ctx.userId,args.connectionId,args.jid);
    case 'whatsapp_removeParticipant':
      return runOwnerAction('WHATSAPP_REMOVE_PARTICIPANT',args.jid,()=>whatsappApi.removeParticipant(ctx.userId,args.connectionId,args.jid,args.participant));
    case 'whatsapp_addParticipant':
      return runOwnerAction('WHATSAPP_ADD_PARTICIPANT',args.jid,()=>whatsappApi.addParticipant(ctx.userId,args.connectionId,args.jid,args.participant));
    case 'whatsapp_promoteParticipant':
      return runOwnerAction('WHATSAPP_PROMOTE_PARTICIPANT',args.jid,()=>whatsappApi.promoteParticipant(ctx.userId,args.connectionId,args.jid,args.participant));
    case 'whatsapp_demoteParticipant':
      return runOwnerAction('WHATSAPP_DEMOTE_PARTICIPANT',args.jid,()=>whatsappApi.demoteParticipant(ctx.userId,args.connectionId,args.jid,args.participant));
    case 'whatsapp_updateGroupSubject':
      return runOwnerAction('WHATSAPP_UPDATE_GROUP_SUBJECT',args.jid,()=>whatsappApi.updateGroupSubject(ctx.userId,args.connectionId,args.jid,args.subject));
    case 'whatsapp_updateGroupDescription':
      return runOwnerAction('WHATSAPP_UPDATE_GROUP_DESCRIPTION',args.jid,()=>whatsappApi.updateGroupDescription(ctx.userId,args.connectionId,args.jid,args.description));
    case 'whatsapp_updateGroupSetting':
      return runOwnerAction('WHATSAPP_UPDATE_GROUP_SETTING',args.jid,()=>whatsappApi.updateGroupSetting(ctx.userId,args.connectionId,args.jid,args.setting));
    case 'whatsapp_leaveGroup':
      return runOwnerAction('WHATSAPP_LEAVE_GROUP',args.jid,()=>whatsappApi.leaveGroup(ctx.userId,args.connectionId,args.jid));
    case 'whatsapp_createGroup':
      return runOwnerAction('WHATSAPP_CREATE_GROUP',args.subject,()=>whatsappApi.createGroup(ctx.userId,args.connectionId,args.subject,args.participants));
    case 'whatsapp_getGroupInviteCode':
      return runOwnerAction('WHATSAPP_GET_GROUP_INVITE_CODE',args.jid,()=>whatsappApi.getGroupInviteCode(ctx.userId,args.connectionId,args.jid));
    case 'whatsapp_revokeGroupInvite':
      return runOwnerAction('WHATSAPP_REVOKE_GROUP_INVITE',args.jid,()=>whatsappApi.revokeGroupInvite(ctx.userId,args.connectionId,args.jid));
    case 'whatsapp_blockContact':
      return runOwnerAction('WHATSAPP_BLOCK_CONTACT',args.jid,()=>whatsappApi.blockContact(ctx.userId,args.connectionId,args.jid));
    case 'whatsapp_unblockContact':
      return runOwnerAction('WHATSAPP_UNBLOCK_CONTACT',args.jid,()=>whatsappApi.unblockContact(ctx.userId,args.connectionId,args.jid));
    case 'whatsapp_archiveChat':
      return runOwnerAction('WHATSAPP_ARCHIVE_CHAT',args.jid,()=>whatsappApi.archiveChat(ctx.userId,args.connectionId,args.jid,args.archive));
    case 'whatsapp_muteChat':
      return runOwnerAction('WHATSAPP_MUTE_CHAT',args.jid,()=>whatsappApi.muteChat(ctx.userId,args.connectionId,args.jid,args.muteHours));
    case 'whatsapp_pinChat':
      return runOwnerAction('WHATSAPP_PIN_CHAT',args.jid,()=>whatsappApi.pinChat(ctx.userId,args.connectionId,args.jid,args.pin));
    case 'whatsapp_deleteMessage':
      return runOwnerAction('WHATSAPP_DELETE_MESSAGE',args.jid,()=>whatsappApi.deleteMessageForEveryone(ctx.userId,args.connectionId,args.jid,args.messageKey));
    case 'whatsapp_updateProfileStatus':
      return runOwnerAction('WHATSAPP_UPDATE_PROFILE_STATUS',ctx.userId,()=>whatsappApi.updateProfileStatus(ctx.userId,args.connectionId,args.status));
    default: return {error:'Tool not found'};
  }
}

async function callOpenAIWithTools(messages,userContext={}){
  if(!config.openaiApiKey) return {content:'OpenAI API Key not configured.',toolCalls:[]};
  let system = `You are AI Premium. User=${userContext.userId||'unknown'}; transport=${userContext.transport||'unknown'}. Use backend tools when current/source-specific information or an external action is required. Never claim a tool action succeeded unless its result confirms success. Clearly distinguish retrieved source information from your own explanation. For WhatsApp, you act as a second owner of the linked account: besides chatting/sending, you can perform full owner-level actions (group admin/settings, blocking, chat archive/mute/pin, message deletion, profile status). Owner-only tools are only authorized from the account owner's own Note-to-Self chat; if refused as unauthorized, tell the user to send the request from their own Note-to-Self chat instead.`;
  if (userContext.autoChatMode) {
    system += ` You are currently in autonomous group-listening mode: you were not directly addressed with .gpt, so only reply if you genuinely have something friendly, helpful, or interesting to add — otherwise reply with exactly the token ${AUTO_CHAT_SKIP_TOKEN} and nothing else. When you do reply, be friendly and helpful, explain things in real detail, and match how this group naturally talks based on the recent messages provided.`;
    if (userContext.chatHistoryHint) system += `\nRecent group conversation for tone reference:\n${userContext.chatHistoryHint}`;
  }
  let current=[{role:'system',content:system},...messages];
  const toolCalls=[];
  try{
    for(let round=0;round<8;round++){
      const response=await openai.chat.completions.create({model:config.openaiModel||'gpt-4o',messages:current,tools,tool_choice:'auto'});
      const msg=response.choices?.[0]?.message;
      if(!msg) throw new Error('OpenAI returned no message');
      if(!msg.tool_calls?.length) return {content:msg.content||'',toolCalls};
      current.push(msg);
      for(const tc of msg.tool_calls){
        let args={};
        try{args=JSON.parse(tc.function.arguments||'{}');}catch(e){args={};}
        const result=await callTool(tc.function.name,args,userContext);
        toolCalls.push({name:tc.function.name,args,result});
        current.push({role:'tool',tool_call_id:tc.id,name:tc.function.name,content:JSON.stringify(result).slice(0,20000)});
      }
    }
    return {content:'The request required too many tool steps. Please narrow the request.',toolCalls};
  }catch(error){ return {content:`Error: ${error.message}`,toolCalls}; }
}
async function generateImage(prompt){
  if(!config.openaiApiKey) return {status:'unavailable',error:'OpenAI API key not configured'};
  try{
    const response=await openai.images.generate({model:'dall-e-3',prompt,n:1,size:'1024x1024'});
    const item=response.data?.[0];
    if(item?.url) return {status:'success',provider:'openai',model:'dall-e-3',prompt,url:item.url};
    if(item?.b64_json) return {status:'success',provider:'openai',model:'dall-e-3',prompt,dataUri:`data:image/png;base64,${item.b64_json}`};
    return {status:'failed',error:'OpenAI returned no image'};
  }catch(error){
    return {status:'unavailable',provider:'openai',error:'Image provider unavailable',details:error.response?.data?.error?.message||error.message};
  }
}

module.exports={callOpenAIWithTools,tools,callTool,generateImage};
