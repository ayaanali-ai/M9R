export const ATTACHMENT_MAX_SIZE_BYTES = 25 * 1024 * 1024;
const MIME_TYPES = new Set(["image/png","image/jpeg","image/gif","image/webp","application/pdf","text/plain","text/markdown","application/json","audio/mpeg","audio/ogg","audio/wav"]);

type Base = { missionId:string; requestId:string; at:string };
export type CollaborationCommand = Base & (
  | {type:"channel.created";channelId:string;name:string;visibility:"public"|"private";memberIds:string[];createdBy:string}
  | {type:"channel.member.added";channelId:string;actorId:string;memberId:string}
  | {type:"message.created";messageId:string;channelId:string;authorId:string;body:string}
  | {type:"message.edited";messageId:string;actorId:string;expectedVersion:number;body:string}
  | {type:"message.deleted";messageId:string;actorId:string;expectedVersion:number}
  | {type:"reaction.toggled";messageId:string;actorId:string;emoji:string}
  | {type:"canvas.created";canvasId:string;channelId:string;title:string;content:Record<string,unknown>;editorIds:string[];createdBy:string}
  | {type:"canvas.content.updated";canvasId:string;actorId:string;expectedVersion:number;content:Record<string,unknown>}
  | {type:"canvas.editor.added";canvasId:string;actorId:string;editorId:string}
  | {type:"huddle.started";huddleId:string;channelId:string;actorId:string}
  | {type:"huddle.joined";huddleId:string;actorId:string}
  | {type:"huddle.muted";huddleId:string;actorId:string;muted:boolean}
  | {type:"huddle.left";huddleId:string;actorId:string}
  | {type:"huddle.ended";huddleId:string;actorId:string}
);
type ErrorItem={code:string};
type Revision={version:number;kind:"created"|"edited"|"deleted";body:string|null;actorId:string;at:string};
export interface CollaborationState {
  missionId:string;humanOwnerId:string;processed:Record<string,string>;
  channels:Array<{id:string;name:string;visibility:"public"|"private";memberIds:string[];createdBy:string}>;
  messages:Array<{id:string;channelId:string;authorId:string;body:string|null;version:number;history:Revision[];tombstone:null|{deletedBy:string;deletedAt:string;version:number}}>;
  reactions:Array<{messageId:string;actorId:string;emoji:string}>;
  canvases:Array<{id:string;channelId:string;title:string;content:Record<string,unknown>;version:number;editorIds:string[];createdBy:string;history:Array<{version:number;content:Record<string,unknown>;editorId:string;at:string}>}>;
  huddles:Array<{id:string;channelId:string;startedBy:string;status:"live"|"ended";participantIds:string[];mutedParticipantIds:string[];startedAt:string;endedAt:string|null;endedBy:string|null}>;
}
export const createCollaborationState=({missionId,humanOwnerId}:{missionId:string;humanOwnerId:string}):CollaborationState=>({missionId,humanOwnerId,processed:{},channels:[],messages:[],reactions:[],canvases:[],huddles:[]});
const digest=(c:CollaborationCommand)=>JSON.stringify(c);
const reject=(s:CollaborationState,code:string)=>({ok:false as const,state:s,errors:[{code}]});
const clone=(s:CollaborationState):CollaborationState=>structuredClone(s);
const canSee=(s:CollaborationState,c:CollaborationState["channels"][number],id:string)=>c.visibility==="public"||id===s.humanOwnerId||c.memberIds.includes(id);
export function getVisibleChannelIds(s:CollaborationState,id:string){return s.channels.filter(c=>canSee(s,c,id)).map(c=>c.id);}
export function validateAttachment(input:unknown):{ok:true}|{ok:false;errors:ErrorItem[]}{
  if(!input||typeof input!=="object"||Array.isArray(input))return rejectValidation("invalid_attachment");
  const value=input as Record<string,unknown>;
  if(value.kind==="url"){try{const u=new URL(String(value.url??""));if(u.protocol!=="https:"||u.username||u.password)return rejectValidation("invalid_url");}catch{return rejectValidation("invalid_url");}return{ok:true};}
  if(value.kind!=="file")return rejectValidation("invalid_attachment");
  const inputFile=value;
  if(typeof inputFile.fileName!=="string"||!inputFile.fileName||inputFile.fileName.includes("/")||inputFile.fileName.includes("\\")||inputFile.fileName.includes(".."))return rejectValidation("invalid_file_name");
  if(typeof inputFile.mimeType!=="string"||!/^[-\w.]+\/[-+\w.]+$/.test(inputFile.mimeType))return rejectValidation("invalid_mime_type");
  if(!MIME_TYPES.has(inputFile.mimeType))return rejectValidation("unsupported_mime_type");
  if(!Number.isSafeInteger(inputFile.sizeBytes)||typeof inputFile.sizeBytes!=="number"||inputFile.sizeBytes<0||inputFile.sizeBytes>ATTACHMENT_MAX_SIZE_BYTES)return rejectValidation("file_too_large");
  return{ok:true};
}
function rejectValidation(code:string){return{ok:false as const,errors:[{code}]};}
export function validateHuddleCommand(input:unknown):{ok:true}|{ok:false;errors:ErrorItem[]}{if(!input||typeof input!=="object")return rejectValidation("invalid_huddle_command");for(const key of ["media","audio","recording","bytes"])if(key in input)return rejectValidation("media_not_persisted");return{ok:true};}
export function reduceCollaboration(state:CollaborationState,command:CollaborationCommand){
  if(command.missionId!==state.missionId)return reject(state,"wrong_mission");
  const d=digest(command),prior=state.processed[command.requestId];if(prior){if(prior!==d)return reject(state,"idempotency_conflict");return{ok:true as const,state,errors:[],receipt:{status:"replayed" as const}};}
  if(command.type.startsWith("huddle.")){const v=validateHuddleCommand(command);if(!v.ok)return{ok:false as const,state,errors:v.errors};}
  const next=clone(state);const channel=(id:string)=>next.channels.find(c=>c.id===id);const message=(id:string)=>next.messages.find(m=>m.id===id);const canvas=(id:string)=>next.canvases.find(c=>c.id===id);const huddle=(id:string)=>next.huddles.find(h=>h.id===id);
  let reactionActive: boolean|undefined;
  switch(command.type){
    case"channel.created":if(channel(command.channelId))return reject(state,"channel_exists");next.channels.push({id:command.channelId,name:command.name,visibility:command.visibility,memberIds:[...new Set(command.memberIds)],createdBy:command.createdBy});break;
    case"channel.member.added":{const c=channel(command.channelId);if(!c)return reject(state,"channel_not_found");if(command.actorId!==state.humanOwnerId&&command.actorId!==c.createdBy)return reject(state,"not_channel_owner");if(!c.memberIds.includes(command.memberId))c.memberIds.push(command.memberId);break;}
    case"message.created":{const c=channel(command.channelId);if(!c)return reject(state,"channel_not_found");if(!canSee(next,c,command.authorId))return reject(state,"not_channel_member");if(message(command.messageId))return reject(state,"message_exists");next.messages.push({id:command.messageId,channelId:command.channelId,authorId:command.authorId,body:command.body,version:1,tombstone:null,history:[{version:1,kind:"created",body:command.body,actorId:command.authorId,at:command.at}]});break;}
    case"message.edited":{const m=message(command.messageId);if(!m)return reject(state,"message_not_found");if(m.tombstone)return reject(state,"message_deleted");if(m.authorId!==command.actorId)return reject(state,"not_message_author");if(m.version!==command.expectedVersion)return reject(state,"version_conflict");m.version++;m.body=command.body;m.history.push({version:m.version,kind:"edited",body:command.body,actorId:command.actorId,at:command.at});break;}
    case"message.deleted":{const m=message(command.messageId);if(!m)return reject(state,"message_not_found");if(m.authorId!==command.actorId&&command.actorId!==state.humanOwnerId)return reject(state,"not_message_author_or_human_owner");if(m.version!==command.expectedVersion)return reject(state,"version_conflict");m.version++;m.body=null;m.tombstone={deletedBy:command.actorId,deletedAt:command.at,version:m.version};m.history.push({version:m.version,kind:"deleted",body:null,actorId:command.actorId,at:command.at});break;}
    case"reaction.toggled":{if(!message(command.messageId))return reject(state,"message_not_found");const i=next.reactions.findIndex(r=>r.messageId===command.messageId&&r.actorId===command.actorId&&r.emoji===command.emoji);if(i>=0){next.reactions.splice(i,1);reactionActive=false;}else{next.reactions.push({messageId:command.messageId,actorId:command.actorId,emoji:command.emoji});reactionActive=true;}break;}
    case"canvas.created":{if(!channel(command.channelId))return reject(state,"channel_not_found");next.canvases.push({id:command.canvasId,channelId:command.channelId,title:command.title,content:command.content,version:1,editorIds:[...new Set(command.editorIds)],createdBy:command.createdBy,history:[{version:1,content:command.content,editorId:command.createdBy,at:command.at}]});break;}
    case"canvas.content.updated":{const c=canvas(command.canvasId);if(!c)return reject(state,"canvas_not_found");if(!c.editorIds.includes(command.actorId))return reject(state,"not_canvas_editor");if(c.version!==command.expectedVersion)return reject(state,"version_conflict");c.version++;c.content=command.content;c.history.push({version:c.version,content:command.content,editorId:command.actorId,at:command.at});break;}
    case"canvas.editor.added":{const c=canvas(command.canvasId);if(!c)return reject(state,"canvas_not_found");if(command.actorId!==state.humanOwnerId&&command.actorId!==c.createdBy)return reject(state,"not_canvas_owner");if(!c.editorIds.includes(command.editorId))c.editorIds.push(command.editorId);break;}
    case"huddle.started":if(huddle(command.huddleId))return reject(state,"huddle_exists");next.huddles.push({id:command.huddleId,channelId:command.channelId,startedBy:command.actorId,status:"live",participantIds:[command.actorId],mutedParticipantIds:[],startedAt:command.at,endedAt:null,endedBy:null});break;
    case"huddle.joined":{const h=huddle(command.huddleId);if(!h||h.status!=="live")return reject(state,"huddle_not_live");if(!h.participantIds.includes(command.actorId))h.participantIds.push(command.actorId);break;}
    case"huddle.muted":{const h=huddle(command.huddleId);if(!h||!h.participantIds.includes(command.actorId))return reject(state,"not_huddle_participant");h.mutedParticipantIds=h.mutedParticipantIds.filter(id=>id!==command.actorId);if(command.muted)h.mutedParticipantIds.push(command.actorId);break;}
    case"huddle.left":{const h=huddle(command.huddleId);if(!h)return reject(state,"huddle_not_found");h.participantIds=h.participantIds.filter(id=>id!==command.actorId);h.mutedParticipantIds=h.mutedParticipantIds.filter(id=>id!==command.actorId);break;}
    case"huddle.ended":{const h=huddle(command.huddleId);if(!h)return reject(state,"huddle_not_found");if(command.actorId!==state.humanOwnerId&&command.actorId!==h.startedBy)return reject(state,"not_huddle_owner");h.status="ended";h.endedAt=command.at;h.endedBy=command.actorId;h.mutedParticipantIds=[];break;}
  }
  next.processed[command.requestId]=d;return{ok:true as const,state:next,errors:[],receipt:{status:"applied" as const,reactionActive}};
}
