import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { LifeBuoy } from "lucide-react";
import { RestaurantAPIError, storefront } from "../api";
import { useLocale } from "../i18n";
import type { Order } from "../types";
import { parseSupportRequest, refundStatusKey, supportStorageKey, type CustomerRefund, type SupportRequest } from "./support";

export function OrderSupportPanel({order, token, customerId = "", onUpdated}: {order:Order; token?:string; customerId?:string; onUpdated:(order:Order)=>void}) {
  const {t,money,date} = useLocale(), reasonId=useId();
  const scope = token ? `receipt:${token}` : `account:${customerId}`;
  const storageKey = supportStorageKey(order.number,scope);
  const [kind,setKind]=useState<SupportRequest["kind"]>("complaints"), [reason,setReason]=useState("");
  const [pending,setPending]=useState<SupportRequest|null>(null), [busy,setBusy]=useState(false),[error,setError]=useState(""),[success,setSuccess]=useState(false);
  const [refunds,setRefunds]=useState<CustomerRefund[]>([]),[refundError,setRefundError]=useState(false),[refundLoaded,setRefundLoaded]=useState(false);
  const gate=useRef(false), mounted=useRef(true);
  const identity=useRef(`${order.number}\n${scope}`);identity.current=`${order.number}\n${scope}`;
  const latestOrder=useRef(order);latestOrder.current=order;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    let restored:SupportRequest|null=null;try{restored=parseSupportRequest(sessionStorage.getItem(storageKey),order.number,scope);}catch{/* memory retry remains available */}
    setPending(restored);setKind(restored?.kind??"complaints");setReason(restored?.reason??"");setError("");setSuccess(false);setBusy(false);
  },[order.number,scope]);
  const remember=(value:SupportRequest|null)=>{setPending(value);try{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}catch{/* no persistent browser storage required */}};
  useEffect(()=>{
    const controller=new AbortController();let reading=false;
    setRefunds([]);setRefundLoaded(false);setRefundError(false);
    const refresh=async()=>{if(reading||document.hidden)return;reading=true;try{const result=await storefront<{refunds:CustomerRefund[]}>(`/orders/${encodeURIComponent(order.number)}/refunds`,{signal:controller.signal,headers:token?{"X-Order-Token":token}:{}});if(!controller.signal.aborted){setRefunds(result.refunds);setRefundLoaded(true);setRefundError(false);}}catch{if(!controller.signal.aborted)setRefundError(true);}finally{reading=false;}};
    void refresh();const timer=setInterval(refresh,15000);return()=>{controller.abort();clearInterval(timer);};
  },[order.number,token,customerId,order.version]);
  const send=async(event:FormEvent)=>{
    event.preventDefault();if(gate.current)return;gate.current=true;setBusy(true);setError("");setSuccess(false);
    const request=pending??{number:order.number,scope,kind,reason:reason.trim(),version:order.version,key:crypto.randomUUID(),createdAt:Date.now(),uncertain:false};
    const requestIdentity=identity.current;
    const current=()=>mounted.current&&identity.current===requestIdentity;
    if(!request.reason){gate.current=false;setBusy(false);return;}
    // Persist before dispatch. A refresh while the request is in flight must
    // retry its immutable identity, not create a second complaint/action.
    remember({...request,uncertain:true});
    try{
      const updated=await storefront<Order>(`/orders/${encodeURIComponent(order.number)}/${request.kind}`,{method:"POST",headers:{"Idempotency-Key":request.key,...(token?{"X-Order-Token":token}:{})},body:JSON.stringify({reason:request.reason,version:request.version})});
      if(current()){remember(null);setReason("");setSuccess(true);if(updated.version>=latestOrder.current.version)onUpdated(updated);}
    }catch(value){if(current()){
      // Backend checks the durable UUID ledger BEFORE current order version.
      // For this unchanged payload a received 409 therefore proves no action
      // committed under the UUID; reload before the user creates a new request.
      const definite=value instanceof RestaurantAPIError&&(value.status===409||(!request.uncertain&&value.status<500&&![401,408,429].includes(value.status)));
      if(definite)remember(null);
      setError(value instanceof RestaurantAPIError?`errors.${value.code}`:"common.error");
      if(value instanceof RestaurantAPIError&&value.status===409){try{const updated=await storefront<Order>(`/orders/${encodeURIComponent(order.number)}`,{headers:token?{"X-Order-Token":token}:{}});if(current()&&updated.version>=latestOrder.current.version)onUpdated(updated);}catch{/* keep last authenticated order */}}
    }}finally{gate.current=false;if(current())setBusy(false);}
  };
  const canCancel=!['completed','cancelled'].includes(order.status)&&order.cancellation?.status!=="requested";
  const decisionReason=order.cancellation?.decisionReason === "before_preparation" ? t("adminSupport.beforePreparation") : order.cancellation?.decisionReason === "restaurant_cancelled" ? t("order.status.cancelled") : order.cancellation?.decisionReason;
  return <section className="rs-panel rs-support">
    <h2><LifeBuoy size={21}/>{t("support.title")}</h2>
    <p className="rs-muted">{t("support.policy")}</p>
    {order.stockExpiresAt&&order.status==="new"&&order.payment?.status!=="paid"&&<p className="rs-notice">{t("support.stockHold")}</p>}
    {order.cancellation&&<div className="rs-support-event"><strong>{t(`support.cancel.${order.cancellation.status}`)}</strong><p>{order.cancellation.reason}</p>{decisionReason&&<p>{t("support.decision")}: {decisionReason}</p>}{order.cancellation.status==="requested"&&<p>{t("support.pending")}</p>}<small>{date(order.cancellation.requestedAt)}</small></div>}
    {(order.complaints??[]).map(complaint=><div className="rs-support-event" key={complaint.id}><strong>{t(`support.complaint.${complaint.status}`)}</strong><p>{complaint.reason}</p>{complaint.resolution&&<p>{t("support.decision")}: {complaint.resolution}</p>}<small>{date(complaint.requestedAt)}</small></div>)}
    {success&&<p role="status" className="rs-notice">{t("support.requestSent")}</p>}
    {error&&<p role="alert" className="rs-notice rs-notice-error">{t(error)}</p>}
    {pending&&<p role="status" className="rs-notice">{t("support.retry")}</p>}
    <form className="rs-form-stack rs-spaced" onSubmit={send}>
      <div className="rs-courier-links">
        <button type="button" className={`rs-button ${kind==="complaints"?"":"rs-button-outline"}`} aria-pressed={kind==="complaints"} disabled={busy||!!pending} onClick={()=>setKind("complaints")}>{t("support.problem")}</button>
        {(canCancel||pending?.kind==="cancel")&&<button type="button" className={`rs-button ${kind==="cancel"?"":"rs-button-outline"}`} aria-pressed={kind==="cancel"} disabled={busy||!!pending} onClick={()=>setKind("cancel")}>{t("support.cancel")}</button>}
      </div>
      <label className="rs-field" htmlFor={reasonId}><span>{t("support.reason")}</span><textarea id={reasonId} required rows={3} maxLength={1000} value={reason} disabled={busy||!!pending} onChange={event=>setReason(event.target.value)}/></label>
      <button className="rs-button" disabled={busy||(!pending&&(!reason.trim()||(kind==="cancel"&&!canCancel)))}>{t(busy?"common.loading":pending?"common.retry":"support.send")}</button>
    </form>
    {(order.cancellation||refunds.length>0||refundError)&&<div className="rs-refunds rs-spaced"><h3>{t("refund.title")}</h3>{refundError&&<p role="status" className="rs-notice">{t("common.error")}</p>}{refundLoaded&&refunds.length===0&&<p className="rs-muted">{t("refund.none")}</p>}{refunds.map(refund=><div className="rs-support-event" key={refund.id}><strong>{t(refundStatusKey(refund))}</strong><p>{money(refund.amountMinor,refund.currency)}</p><small>{date(refund.updatedAt)}</small>{refundStatusKey(refund)==="refund.succeeded"&&<p className="rs-muted">{t("refund.bankDelay")}</p>}{refundStatusKey(refund)==="refund.manual_reported"&&<p className="rs-notice">{t("refund.manualWarning")}</p>}</div>)}</div>}
  </section>;
}
