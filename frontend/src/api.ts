
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
export function getToken(){return localStorage.getItem('rtb_token')||''}
export function setToken(t:string){localStorage.setItem('rtb_token',t)}
export function clearToken(){localStorage.removeItem('rtb_token')}
export async function api<T=any>(path:string, options:RequestInit={}) : Promise<T> {
  const headers:Record<string,string>={'Content-Type':'application/json',...(options.headers as Record<string,string>||{})};
  if(getToken())headers.Authorization=`Bearer ${getToken()}`;
  const res=await fetch(`${BASE}${path}`,{...options,headers});
  const data=await res.json().catch(()=>({error:'Unexpected server response'}));
  if(!res.ok)throw new Error(data.error||`Request failed (${res.status})`);
  return data as T;
}
export const csvDownload=(rows:any[], filename:string)=>{
  const esc=(v:any)=>`"${String(v??'').replaceAll('"','""')}"`;
  const keys=rows.length?Object.keys(rows[0]):[];
  const csv=[keys.map(esc).join(','),...rows.map(r=>keys.map(k=>esc(r[k])).join(','))].join('\r\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url);
};
