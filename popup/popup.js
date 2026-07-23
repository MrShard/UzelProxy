(()=>{try{document.addEventListener("contextmenu",e=>e.preventDefault())}catch{}
const t=e("on_off_switcher"),n=e("pulse1");
function e(e){return document.querySelector(`#${e}`)}
function r(e,t){chrome.action.setIcon({path:e}),chrome.action.setTitle({title:t})}
function i(e){return new Promise(t=>{chrome.storage.local.set(e,t)})}
function a(e){return new Promise(t=>{chrome.storage.local.get(e,t)})}
function s(e){chrome.tabs.create({url:e})}

// Сообщение в попап. color: зелёный #15a535 / красный #d00 / синий #1959a6.
function showMsg(id,msg,color){const el=e(id);if(!el)return;el.style.color=color||'#39393a';el.innerText=msg}

// Текущий активный прокси для отображения на главном экране.
async function renderActiveProxy(){
    const d=await a(["proxies","activeProxyId"]);
    const el=e("active_proxy_info");
    if(!el)return;
    const list=Array.isArray(d.proxies)?d.proxies:[];
    const active=list.find(p=>p.id===d.activeProxyId);
    if(active){
        const tname=active.type==="SOCKS5"?"SOCKS5":"HTTP/S";
        el.innerHTML='Активен: <b>'+(active.name||tname+' '+active.host+':'+active.port)+'</b><br><span class=ap-addr>'+tname+' · '+active.host+':'+active.port+'</span>';
        el.style.display="block";
    }else{
        el.innerHTML='Прокси не выбран. Добавьте его в <a href=# id=go_proxy_mgr class=ap-link>Менеджере прокси</a>.';
        el.style.display="block";
        const lk=e("go_proxy_mgr");if(lk)lk.onclick=(ev)=>{ev.preventDefault();e("proxy_btn").onclick()};
    }
}

async function o(){const{isEnabled:s,disableExtensions:o}=await a(["isEnabled","disableExtensions"]);chrome.runtime.sendMessage({apply:"err"},i=>{i.ext=="controlled_by_other_extensions"&&s?chrome.action.getBadgeText({},t=>{(t==="err"||t=="")&&!o&&(e("on_off_switcher").disabled=!0,e("control").style.display="none",e("share").style.display="none",e("noControl").style.display="block",r("../icon-128-disabled.png","err"))}):(e("on_off_switcher").disabled=!1,e("noControl").style.display="none",e("control").style.display="initial",e("share").style.display="table"),s?(t.checked=!0,n.style.animation="",n.style["box-shadow"]="inset 0px 0px 15px 10px rgb(34, 29, 136)"):(t.checked=!1,n.style.animation="stop",n.style["box-shadow"]="none")});renderActiveProxy()}

async function c(){t.addEventListener("change",async()=>{
    // Защита: нельзя включить без активного прокси.
    if(t.checked){
        const d=await a(["activeProxyId"]);
        if(!d.activeProxyId){
            t.checked=false;
            i({isEnabled:false});
            const nc=e("noControl");if(nc){nc.style.display="block",nc.innerHTML='Сначала добавьте прокси в <a href=# id=go_mgr class=nc-link>Менеджере прокси</a>.',nc.title=""}
            const lk=e("go_mgr");if(lk)lk.onclick=(ev)=>{ev.preventDefault();e("proxy_btn").onclick()};
            return;
        }
    }
    i({isEnabled:t.checked}),chrome.action.setBadgeText({text:""}),o(),chrome.runtime.sendMessage({apply:"rebuild"})
})}

function fmtDate(dtime){try{return dtime?new Date(dtime).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—"}catch{return dtime||"—"}}

// Экран «Управление»: заполнение состояния списка и версии.
async function fillManage(){
    const ver=chrome.runtime.getManifest().version;
    const cv=e("cur_ver");if(cv)cv.innerText=ver;
    const st=e("list_status"),ct=e("list_count"),up=e("list_updated");
    chrome.runtime.sendMessage({apply:"listInfo"},r=>{
        if(!r){if(st)st.innerText="Нет данных";return}
        if(st)st.innerText=r.useGitList?"Список включён в настройках":"Список выключен в настройках";
        if(ct)ct.innerText="Доменов в кеше: "+r.count;
        if(up)up.innerText="Обновлён: "+fmtDate(r.dtime);
    });
}

function bindManage(){
    e("manage_btn").onclick=()=>{e("main").style.display="none",e("opt").style.display="none",e("proxyMgr").style.display="none",e("manage").style.display="block",fillManage()};
    e("manage_back").onclick=()=>{e("manage").style.display="none",e("main").style.display="block"};
    e("update_list_btn").onclick=()=>{
        showMsg("update_list_msg","Обновление…","#1959a6");
        e("update_list_btn").disabled=true;
        chrome.runtime.sendMessage({apply:"updateList"},r=>{
            e("update_list_btn").disabled=false;
            if(!r){showMsg("update_list_msg","Ошибка: нет ответа","#d00");return}
            if(r.error==="inflight"){showMsg("update_list_msg","Обновление уже идёт, подождите","#1959a6");return}
            if(!r.ok&&r.error){showMsg("update_list_msg","Не удалось обновить (используется кеш)","#d00");fillManage();return}
            if(r.unchanged){showMsg("update_list_msg","Список актуален — изменений нет","#15a535")}
            else{showMsg("update_list_msg","Список обновлён ("+r.count+" доменов)","#15a535")}
            fillManage();
        });
    };
    e("check_update_btn").onclick=()=>{
        showMsg("check_update_msg","Проверка…","#1959a6");
        e("check_update_btn").disabled=true;
        chrome.runtime.sendMessage({apply:"checkUpdate"},r=>{
            e("check_update_btn").disabled=false;
            if(!r){showMsg("check_update_msg","Ошибка: нет ответа","#d00");return}
            if(r.error){showMsg("check_update_msg","Не удалось проверить обновление","#d00");return}
            if(r.hasUpdate){showMsg("check_update_msg","Доступна новая версия: "+r.latest+". Открываю страницу релиза…","#15a535");s(r.url)}
            else{showMsg("check_update_msg","У вас актуальная версия ("+r.current+")","#15a535")}
        });
    };
}

// ============================================================================
//  Менеджер прокси: сохранение нескольких прокси с выбором активного + проверка
// ============================================================================
function genId(){return 'p'+Date.now().toString(36)+Math.random().toString(36).slice(2,6)}

async function syncUserProxy(activeProxy){
    // Синхронизирует user_proxy* (проекция активного прокси) и триггерит rebuild.
    if(activeProxy){
        await i({user_proxy:!0,user_proxy_type:activeProxy.type,user_proxy_http:activeProxy.host,user_proxy_port:String(activeProxy.port),activeProxyId:activeProxy.id});
    }else{
        await i({user_proxy:!1,activeProxyId:null});
    }
    chrome.runtime.sendMessage({apply:"rebuild"});
}

function renderProxyList(proxies,activeId){
    const list=e("proxy_list"),empty=e("proxy_list_empty");
    list.innerHTML="";
    if(!proxies||proxies.length===0){empty.style.display="block";return}
    empty.style.display="none";
    proxies.forEach(p=>{
        const isAct=p.id===activeId;
        const item=document.createElement("div");
        item.className="proxy-item"+(isAct?" active":"");
        const head=document.createElement("div");head.className="proxy-item-head";
        const radio=document.createElement("input");radio.type="radio";radio.name="activeProxy";radio.checked=isAct;
        radio.onchange=()=>setActive(p.id);
        const nm=document.createElement("div");nm.className="proxy-item-name";nm.textContent=p.name||(p.type==="SOCKS5"?"SOCKS5":"HTTP/S")+" "+p.host+":"+p.port;
        head.appendChild(radio);head.appendChild(nm);
        const addr=document.createElement("div");addr.className="proxy-item-addr";addr.textContent=(p.type==="SOCKS5"?"SOCKS5":"HTTP/S")+" · "+p.host+":"+p.port+(p.name?"":"");
        const act=document.createElement("div");act.className="proxy-item-actions";
        const chk=document.createElement("button");chk.textContent="Проверить";chk.onclick=()=>checkProxy(p.id);
        const del=document.createElement("button");del.textContent="Удалить";del.onclick=()=>removeProxy(p.id);
        act.appendChild(chk);act.appendChild(del);
        const chkMsg=document.createElement("div");chkMsg.className="proxy-check";chkMsg.id="proxy_check_"+p.id;
        item.appendChild(head);item.appendChild(addr);item.appendChild(act);item.appendChild(chkMsg);
        list.appendChild(item);
    });
}

async function fillProxyMgr(){
    const d=await a(["proxies","activeProxyId"]);
    renderProxyList(d.proxies||[],d.activeProxyId||null);
    showMsg("pm_add_msg","");
}

async function addProxy(){
    const name=e("pm_name").value.trim();
    const type=e("pm_type").value;
    const host=e("pm_host").value.trim();
    const port=e("pm_port").value.trim();
    // Валидация
    if(!host||host.length<3){showMsg("pm_add_msg","Введите корректный хост","#d00");return}
    const pn=Number(port);
    if(!port||!Number.isInteger(pn)||pn<1||pn>65535){showMsg("pm_add_msg","Порт — число от 1 до 65535","#d00");return}
    const d=await a(["proxies","activeProxyId"]);
    const proxies=Array.isArray(d.proxies)?d.proxies:[];
    const proxy={id:genId(),name:name||null,type,host,port:pn,added:Date.now()};
    proxies.push(proxy);
    // Если активного нет — новый становится активным.
    let activeId=d.activeProxyId||null;
    const updates={proxies};
    if(!activeId){activeId=proxy.id;updates.activeProxyId=activeId;updates.user_proxy=!0;updates.user_proxy_type=type;updates.user_proxy_http=host;updates.user_proxy_port=String(pn)}
    await i(updates);
    if(activeId===proxy.id)chrome.runtime.sendMessage({apply:"rebuild"});
    // Очистка формы
    e("pm_name").value="";e("pm_host").value="";e("pm_port").value="";
    showMsg("pm_add_msg","Прокси добавлен","#15a535");
    renderProxyList(proxies,activeId);
}

async function setActive(id){
    const d=await a(["proxies","activeProxyId"]);
    const proxies=Array.isArray(d.proxies)?d.proxies:[];
    const p=proxies.find(x=>x.id===id);
    if(!p)return;
    await syncUserProxy(p);
    renderProxyList(proxies,id);
}

async function removeProxy(id){
    const d=await a(["proxies","activeProxyId"]);
    const proxies=(Array.isArray(d.proxies)?d.proxies:[]).filter(x=>x.id!==id);
    const wasActive=d.activeProxyId===id;
    if(wasActive){
        // Удалили активный — активного нет, прокси выкл.
        await i({proxies,activeProxyId:null,user_proxy:!1});
        chrome.runtime.sendMessage({apply:"rebuild"});
    }else{
        await i({proxies});
    }
    renderProxyList(proxies,wasActive?null:d.activeProxyId);
}

function checkProxy(id){
    const msg=e("proxy_check_"+id);
    if(!msg)return;
    msg.className="proxy-check wait";msg.textContent="⏳ Проверяем…";
    // Нужен type/host/port — перечитаем список, затем шлём сообщение с параметрами.
    (async()=>{
        const d=await a(["proxies"]);
        const p=(d.proxies||[]).find(x=>x.id===id);
        if(!p){msg.className="proxy-check err";msg.textContent="Прокси не найден";return}
        chrome.runtime.sendMessage({apply:"checkProxy",type:p.type,host:p.host,port:String(p.port)},r=>{
            if(!r){msg.className="proxy-check err";msg.textContent="✗ Нет ответа";return}
            if(r.ok){msg.className="proxy-check ok";msg.textContent="✓ Работает · IP "+(r.ip||"?")+(r.country?" ("+r.country+")":"")}
            else{
                const map={timeout:"таймаут",network:"нет соединения",controlled_by_other:"другое расширение контролирует прокси"};
                msg.className="proxy-check err";msg.textContent="✗ Не работает ("+(map[r.error]||r.error)+")";
            }
        });
    })();
}

function bindProxyMgr(){
    e("proxy_btn").onclick=()=>{e("main").style.display="none",e("opt").style.display="none",e("manage").style.display="none",e("proxyMgr").style.display="block",fillProxyMgr()};
    e("proxyMgr_back").onclick=()=>{e("proxyMgr").style.display="none",e("main").style.display="block"};
    e("pm_add_btn").onclick=()=>addProxy();
}

function l(){e("vk").onclick=()=>{u()},e("ok").onclick=()=>{h()},e("fb").onclick=()=>{m()},e("settings").onclick=()=>{e("main").style.display="none",e("manage").style.display="none",e("proxyMgr").style.display="none",e("opt").style.display="block"};e("opt_back").onclick=()=>{e("opt").style.display="none",e("main").style.display="block"},e("support").onclick=()=>{d()},e("support_email").onclick=()=>{e("e_mail_address").style.display="table"},e("p_email").onclick=()=>{e("e_mail_address").style.display="table"},e("support_vk").onclick=()=>{s("https://github.com/MrShard/UzelProxy")},e("p_vk").onclick=()=>{s("https://github.com/MrShard/UzelProxy")},e("system").onclick=()=>{s("chrome://extensions")}}
function d(){const t=e("bottom_open").style,n=e("e_mail_address").style;t.display=="table"?(t.display="none",n.display="none"):(t.display="table",n.display="none")}
function u(){window.open(`https://vk.com/share.php?url=https://github.com/MrShard/UzelProxy/?utm_source=from_vk&title=UzelProxy&description=Гибкое управление личными прокси в браузере.`,"","menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=600,width=600")}
function h(){window.open(`https://connect.ok.ru/offer?url=https://github.com/MrShard/UzelProxy/?utm_source=from_ok&title=UzelProxy&description=Гибкое управление личными прокси в браузере.`,"","menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=600,width=600")}
function m(){window.open(`https://www.facebook.com/sharer.php?u=https://github.com/MrShard/UzelProxy/?utm_source=from_facebook&title=UzelProxy`,"","menubar=no,sharer,toolbar=no,resizable=yes,scrollbars=yes,height=600,width=600")}
function f(){o(),c(),l(),bindManage(),bindProxyMgr()}
f()})()
