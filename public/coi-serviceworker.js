/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
let coepCredentialless=false;
if(typeof window==="undefined"){
  self.addEventListener("install",()=>self.skipWaiting());
  self.addEventListener("activate",event=>event.waitUntil(self.clients.claim()));
  self.addEventListener("message",event=>{
    if(!event.data)return;
    if(event.data.type==="deregister"){
      self.registration.unregister().then(()=>self.clients.matchAll()).then(clients=>clients.forEach(client=>client.navigate(client.url)));
    }else if(event.data.type==="coepCredentialless"){
      coepCredentialless=event.data.value;
    }
  });
  self.addEventListener("fetch",event=>{
    const request=event.request;
    if(request.cache==="only-if-cached"&&request.mode!=="same-origin")return;
    const isolatedRequest=coepCredentialless&&request.mode==="no-cors"?new Request(request,{credentials:"omit"}):request;
    event.respondWith(fetch(isolatedRequest).then(response=>{
      if(response.status===0)return response;
      const headers=new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy",coepCredentialless?"credentialless":"require-corp");
      if(!coepCredentialless)headers.set("Cross-Origin-Resource-Policy","cross-origin");
      headers.set("Cross-Origin-Opener-Policy","same-origin");
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    }).catch(error=>console.error(error)));
  });
}else{
  const options={shouldRegister:()=>true,shouldDeregister:()=>false,coepCredentialless:()=>true,doReload:()=>window.location.reload(),quiet:false,...window.coi};
  const serviceWorker=navigator.serviceWorker;
  if(serviceWorker&&serviceWorker.controller){
    serviceWorker.controller.postMessage({type:"coepCredentialless",value:options.coepCredentialless()});
    if(options.shouldDeregister())serviceWorker.controller.postMessage({type:"deregister"});
  }
  if(window.crossOriginIsolated===false&&options.shouldRegister()){
    if(window.isSecureContext){
      serviceWorker&&serviceWorker.register(document.currentScript.src).then(registration=>{
        if(!options.quiet)console.log("COOP/COEP Service Worker registered",registration.scope);
        registration.addEventListener("updatefound",()=>options.doReload());
        if(registration.active&&!serviceWorker.controller)options.doReload();
      },error=>console.error("COOP/COEP Service Worker failed to register:",error));
    }else if(!options.quiet){
      console.log("COOP/COEP Service Worker not registered: a secure context is required.");
    }
  }
}
