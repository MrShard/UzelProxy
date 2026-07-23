(()=>{try{document.addEventListener("contextmenu",e=>e.preventDefault())}catch{}
const t=e("on_off_switcher"),n=e("pulse1");
function e(e){return document.querySelector(`#${e}`)}
function r(e,t){chrome.action.setIcon({path:e}),chrome.action.setTitle({title:t})}
function i(e){return new Promise(t=>{chrome.storage.local.set(e,t)})}
function a(e){return new Promise(t=>{chrome.storage.local.get(e,t)})}
function s(e){chrome.tabs.create({url:e})}

// Сообщение в попап (для экрана «Управление»). color: '#15d215' зелёный / '#ff0000' красный.
function showManageMsg(id,msg,color){const el=e(id);if(!el)return;el.style.color=color||'#39393a';el.innerText=msg}

async function o(){const{isEnabled:s,disableExtensions:o}=await a(["isEnabled","disableExtensions"]);chrome.runtime.sendMessage({apply:"err"},i=>{i.ext=="controlled_by_other_extensions"&&s?chrome.action.getBadgeText({},t=>{(t==="err"||t=="")&&!o&&(e("on_off_switcher").disabled=!0,e("control").style.display="none",e("share").style.display="none",e("noControl").style.display="block",r("../icon-128-disabled.png","err"))}):(e("on_off_switcher").disabled=!1,e("noControl").style.display="none",e("control").style.display="initial",e("share").style.display="table"),s?(t.checked=!0,n.style.animation="",n.style["box-shadow"]="inset 0px 0px 15px 10px rgb(34, 29, 136)"):(t.checked=!1,n.style.animation="stop",n.style["box-shadow"]="none")})}

async function c(){t.addEventListener("change",()=>{i({isEnabled:t.checked}),chrome.action.setBadgeText({text:""}),o(),chrome.runtime.sendMessage({apply:"rebuild"})})}

function fmtDate(dtime){try{return dtime?new Date(dtime).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—"}catch{return dtime||"—"}}

// Экран «Управление»: заполнение текущего состояния списка и версии.
async function fillManage(){
    // Версия расширения
    const ver=chrome.runtime.getManifest().version;
    const cv=e("cur_ver");if(cv)cv.innerText=ver;
    // Состояние списка
    const st=e("list_status"),ct=e("list_count"),up=e("list_updated");
    chrome.runtime.sendMessage({apply:"listInfo"},r=>{
        if(!r){if(st)st.innerText="Нет данных";return}
        if(st)st.innerText=r.useGitList?"Список включён в настройках":"Список выключен в настройках";
        if(ct)ct.innerText="Доменов в кеше: "+r.count;
        if(up)up.innerText="Обновлён: "+fmtDate(r.dtime);
    });
}

function bindManage(){
    // Навигация
    e("manage_btn").onclick=()=>{e("main").style.display="none",e("opt").style.display="none",e("manage").style.display="block",fillManage()};
    e("manage_back").onclick=()=>{e("manage").style.display="none",e("main").style.display="block"};
    // Кнопка «Обновить список»
    e("update_list_btn").onclick=()=>{
        showManageMsg("update_list_msg","Обновление…","#1959a6");
        e("update_list_btn").disabled=true;
        chrome.runtime.sendMessage({apply:"updateList"},r=>{
            e("update_list_btn").disabled=false;
            if(!r){showManageMsg("update_list_msg","Ошибка: нет ответа","#ff0000");return}
            if(r.error==="inflight"){showManageMsg("update_list_msg","Обновление уже идёт, подождите","#1959a6");return}
            if(!r.ok&&r.error){showManageMsg("update_list_msg","Не удалось обновить (используется кеш)","#ff0000");fillManage();return}
            if(r.unchanged){showManageMsg("update_list_msg","Список актуален — изменений нет","#15d215")}
            else{showManageMsg("update_list_msg","Список обновлён ("+r.count+" доменов)","#15d215")}
            fillManage();
        });
    };
    // Кнопка «Проверить обновление»
    e("check_update_btn").onclick=()=>{
        showManageMsg("check_update_msg","Проверка…","#1959a6");
        e("check_update_btn").disabled=true;
        chrome.runtime.sendMessage({apply:"checkUpdate"},r=>{
            e("check_update_btn").disabled=false;
            if(!r){showManageMsg("check_update_msg","Ошибка: нет ответа","#ff0000");return}
            if(r.error){showManageMsg("check_update_msg","Не удалось проверить обновление","#ff0000");return}
            if(r.hasUpdate){showManageMsg("check_update_msg","Доступна новая версия: "+r.latest+". Открываю страницу релиза…","#15d215");s(r.url)}
            else{showManageMsg("check_update_msg","У вас актуальная версия ("+r.current+")","#15d215")}
        });
    };
}

function l(){e("vk").onclick=()=>{u()},e("ok").onclick=()=>{h()},e("fb").onclick=()=>{m()},e("settings").onclick=()=>{e("main").style.display="none",e("manage").style.display="none",e("opt").style.display="block"},e("support").onclick=()=>{d()},e("support_email").onclick=()=>{e("e_mail_address").style.display="table"},e("p_email").onclick=()=>{e("e_mail_address").style.display="table"},e("support_vk").onclick=()=>{s("https://example.com")},e("p_vk").onclick=()=>{s("https://example.com")},e("system").onclick=()=>{s("chrome://settings/system")}}
function d(){const t=e("bottom_open").style,n=e("e_mail_address").style;t.display=="table"?(t.display="none",n.display="none"):(t.display="table",n.display="none")}
function u(){window.open(`https://vk.com/share.php?url=https://example.com/?utm_source=from_vk&title=UzelProxy&description=Гибкое управление личными прокси в браузере.`,"","menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=600,width=600")}
function h(){window.open(`https://connect.ok.ru/offer?url=https://example.com/?utm_source=from_ok&title=UzelProxy&description=Гибкое управление личными прокси в браузере.`,"","menubar=no,toolbar=no,resizable=yes,scrollbars=yes,height=600,width=600")}
function m(){window.open(`https://www.facebook.com/sharer.php?u=https://example.com/?utm_source=from_facebook&title=UzelProxy`,"","menubar=no,sharer,toolbar=no,resizable=yes,scrollbars=yes,height=600,width=600")}
function f(){o(),c(),l(),bindManage()}
f()})()
