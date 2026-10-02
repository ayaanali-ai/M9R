"use client";
import {useCallback,useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import Link from "next/link";
import ProductConfirmDialog from "../ProductConfirmDialog";
interface Roster {canManage:boolean;canRemove:boolean;agents:{connectionId:string;label:string;provider:string;inChannel:boolean}[]}
export function ChannelAgentControls({conversationId}:{conversationId:string}) {
 const router=useRouter();const [roster,setRoster]=useState<Roster|null>(null);const [error,setError]=useState<string|null>(null);const [busy,setBusy]=useState(false);const [remove,setRemove]=useState<string|null>(null);
 const load=useCallback(async()=>{
  const res=await fetch(`/api/dashboard/channel-agents?conversationId=${encodeURIComponent(conversationId)}`,{cache:"no-store"});const body=await res.json();if(!res.ok)throw new Error(body.error??"Could not load channel agents.");setRoster(body);
 },[conversationId]);
 useEffect(()=>{let active=true;void Promise.resolve().then(()=>{if(active)return load();}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[load]);
 async function change(connectionId:string,add:boolean){setBusy(true);setError(null);try{
  const res=await fetch("/api/dashboard/channel-agents",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({conversationId,connectionId,add})});const body=await res.json();if(!res.ok)throw new Error(body.error??"Could not change membership.");await load();router.refresh();
 }catch(e){setError(e instanceof Error?e.message:"Could not change membership.");}finally{setBusy(false);setRemove(null);}}
 return <section className="p-3 border-b border-[color:var(--ol-border-subtle)]"><h3 className="text-sm font-medium">Channel agents</h3><p className="text-xs text-[color:var(--ol-text-muted)]">Channel removal restricts this channel&apos;s messages and memory. Disconnect in Settings to revoke workspace access.</p>
  {error&&<p role="alert">{error}</p>}{!roster&&!error&&<p>Loading agents…</p>}
  {roster?.agents.map(agent=><div key={agent.connectionId} className="flex items-center justify-between gap-2 py-2"><span>{agent.label}<small className="ml-2">{agent.provider}</small></span>{roster.canManage?<button type="button" disabled={busy||(agent.inChannel&&!roster.canRemove)} onClick={()=>agent.inChannel?setRemove(agent.connectionId):void change(agent.connectionId,true)}>{agent.inChannel?"Remove":"Add"}</button>:<span>{agent.inChannel?"In channel":"Outside channel"}</span>}</div>)}
  <div className="flex gap-3 text-xs"><Link href={`/dashboard/memory?tab=notes&channel=${encodeURIComponent(conversationId)}`}>Shared channel memory</Link><Link href="/dashboard/settings#team">Manage team</Link></div>
  <ProductConfirmDialog open={remove!==null} title="Remove this agent from the channel?" description="Future channel messages and saved channel memory will be unavailable. A running turn may finish using information already received." confirmLabel="Remove agent" busy={busy} onCancel={()=>setRemove(null)} onConfirm={()=>{if(remove)void change(remove,false);}} />
 </section>;
}
