// ===== Auth + API =====
const store = {
  get token() { return localStorage.getItem("token"); },
  get user() { try { return JSON.parse(localStorage.getItem("user")); } catch { return null; } },
  login(d) { localStorage.setItem("token", d.token); localStorage.setItem("user", JSON.stringify(d.user)); },
  logout() { localStorage.removeItem("token"); localStorage.removeItem("user"); location.href = "/login.html"; },
};

async function api(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(store.token ? { Authorization: "Bearer " + store.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && store.token) store.logout();
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

// ===== helpers =====
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const COLORS = ["#5b3df5", "#0ea5e9", "#10b981", "#f59e0b", "#ec4899", "#8b5cf6", "#14b8a6"];
const avatar = (name, cls = "") =>
  `<div class="avatar ${cls}" style="background:${COLORS[name.charCodeAt(0) % COLORS.length]}">${esc(name[0].toUpperCase())}</div>`;

function timeAgo(sqlDate) {
  const s = Math.floor((Date.now() - new Date(sqlDate.replace(" ", "T") + "Z")) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}

function toast(t) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.textContent = t; el.classList.add("show");
  clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove("show"), 2200);
}

function renderHeader() {
  const el = $("#site-header"); if (!el) return;
  const u = store.user;
  el.innerHTML = `<div class="inner"><a class="brand" href="/">adda</a>
    <nav class="nav">${u ? `<a href="/profile.html?id=${u.id}">@${esc(u.username)}</a><button id="logout">Log out</button>`
                          : `<a href="/login.html">Log in</a>`}</nav></div>`;
  if (u) $("#logout").onclick = () => store.logout();
}
document.addEventListener("DOMContentLoaded", renderHeader);

// ===== posts (shared by feed + profile pages) =====
function postHTML(p) {
  const me = store.user;
  return `
  <article class="card post" data-id="${p.id}">
    <div class="head">${avatar(p.username)}
      <div><a class="who" href="/profile.html?id=${p.user_id}">@${esc(p.username)}</a><div class="when">${timeAgo(p.created_at)}</div></div>
    </div>
    <div class="text">${esc(p.content)}</div>
    <div class="bar">
      <button class="act like ${p.liked ? "liked" : ""}">${p.liked ? "♥" : "♡"} <span>${p.likes}</span></button>
      <button class="act cmt">💬 <span>${p.comments}</span></button>
      ${me && me.id === p.user_id ? `<button class="act del">Delete</button>` : ""}
    </div>
    <div class="comments" hidden></div>
  </article>`;
}

function renderPosts(container, posts, reload) {
  container.innerHTML = posts.length ? posts.map(postHTML).join("") : `<div class="empty">Nothing here yet.</div>`;
  container.querySelectorAll(".post").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".like").onclick = async () => {
      try { const r = await api(`/api/posts/${id}/like`, "POST");
        const b = el.querySelector(".like"); b.classList.toggle("liked", r.liked);
        b.innerHTML = `${r.liked ? "♥" : "♡"} <span>${r.likes}</span>`;
      } catch (e) { toast(store.token ? e.message : "Log in to like posts."); }
    };
    el.querySelector(".cmt").onclick = () => toggleComments(el, id);
    const del = el.querySelector(".del");
    if (del) del.onclick = async () => {
      if (!confirm("Delete this post?")) return;
      try { await api(`/api/posts/${id}`, "DELETE"); toast("Post deleted"); reload(); } catch (e) { toast(e.message); }
    };
  });
}

async function toggleComments(el, id) {
  const box = el.querySelector(".comments");
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  await loadComments(el, id);
}

async function loadComments(el, id) {
  const box = el.querySelector(".comments"), me = store.user;
  const list = await api(`/api/posts/${id}/comments`);
  box.innerHTML = list.map((c) => `
    <div class="comment">${avatar(c.username)}
      <div><b>@${esc(c.username)}</b> ${esc(c.content)}</div>
      ${me && me.id === c.user_id ? `<button class="x" data-c="${c.id}" aria-label="Delete comment">✕</button>` : ""}
    </div>`).join("") +
    (me ? `<form class="comment-form"><input maxlength="200" placeholder="Write a comment" aria-label="Comment"><button class="btn">Reply</button></form>`
        : `<div class="empty" style="padding:8px"><a href="/login.html" style="color:var(--brand)">Log in</a> to comment.</div>`);
  el.querySelector(".cmt span").textContent = list.length;
  box.querySelectorAll(".x").forEach((b) => b.onclick = async () => {
    try { await api(`/api/comments/${b.dataset.c}`, "DELETE"); loadComments(el, id); } catch (e) { toast(e.message); }
  });
  const form = box.querySelector("form");
  if (form) form.onsubmit = async (ev) => {
    ev.preventDefault();
    const input = form.querySelector("input");
    try { await api(`/api/posts/${id}/comments`, "POST", { content: input.value }); loadComments(el, id); }
    catch (e) { toast(e.message); }
  };
}

async function toggleFollow(userId, btn) {
  try {
    const r = await api(`/api/users/${userId}/follow`, "POST");
    btn.textContent = r.following ? "Following" : "Follow";
    btn.classList.toggle("ghost", r.following);
    return r;
  } catch (e) { toast(store.token ? e.message : "Log in to follow people."); }
}
