(() => {
  'use strict';
  let token=sessionStorage.getItem('birdeye-token')||'';
  const dialog=document.querySelector('#login-dialog');
  const api={connected:false,onLogin:async()=>{},
    async request(route,method='GET',body){
      const response=await fetch('/api'+route,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
      if(response.status===401){api.connected=false;token='';sessionStorage.removeItem('birdeye-token');if(!dialog.open)dialog.showModal();throw new Error('Sign in with your administrator token.');}
      let data;try{data=await response.json();}catch{throw new Error('The Birdeye API is unavailable. Open the address served by Docker or the API server.');}
      if(!response.ok)throw new Error(data.error||'Request failed');
      return data;
    },
    async start(){
      if(token){try{await api.onLogin();api.connected=true;return;}catch(error){document.querySelector('#login-error').textContent=error.message;}}
      if(!dialog.open)dialog.showModal();
    }
  };
  dialog.addEventListener('cancel',event=>event.preventDefault());
  // The other dialogs dismiss on backdrop clicks; authentication must stay open.
  dialog.addEventListener('click',event=>event.stopImmediatePropagation(),true);
  document.querySelector('#login-form').onsubmit=async event=>{
    event.preventDefault();token=document.querySelector('#admin-token').value.trim();
    const button=event.target.querySelector('button');button.disabled=true;
    try{await api.onLogin();api.connected=true;sessionStorage.setItem('birdeye-token',token);document.querySelector('#admin-token').value='';dialog.close();}
    catch(error){document.querySelector('#login-error').textContent=error.message;}
    finally{button.disabled=false;}
  };
  document.querySelector('#sign-out').onclick=()=>{sessionStorage.removeItem('birdeye-token');location.reload();};
  window.BirdeyeAPI=api;
})();
