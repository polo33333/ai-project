// Login theme palette and motion styles, kept outside the illustration templates.
module.exports = `
/* Dark surfaces carry their own contrast instead of translucent pale overlays. */
html[data-theme=dark] .dashboard{opacity:1;background:#2b243c;border-color:#675183;box-shadow:inset 0 0 0 5px #ffffff03,0 17px 0 -10px #5c4384,0 27px 24px -18px #100c25}
html[data-theme=dark] .dash-brand{color:#f0e8ff}
html[data-theme=dark] .dash-sidebar{color:#b8a2dc}
html[data-theme=dark] .dash-main{background:#32283f;color:#eee4ff}
html[data-theme=dark] .ask{background:#3d304e;border-color:#68547f;color:#e1d3f4;box-shadow:none}
html[data-theme=dark] .tile{background:#40324f;color:#eee4ff;box-shadow:0 5px 15px #0c08151c}
html[data-theme=dark] .dash-skeleton div{background:#4d3a65}
html[data-theme=dark] .float-card{background:#352b45f5;border-color:#68547f;color:#f1e7ff}
html[data-theme=dark] .float-card small{color:#cdbbdf}
html[data-theme=dark] .document-board,html[data-theme=dark] .analysis-board{background:#2b243b;border-color:#66517e;box-shadow:inset 0 0 0 5px #ffffff03,0 18px 0 -12px #63498b,0 26px 24px -15px #100b25}
html[data-theme=dark] .scene-heading{color:#eee3fb}
html[data-theme=dark] .scene-badge{background:#443450;border-color:#6b537e;color:#e2cfee}
html[data-theme=dark] .doc-search{background:#382d45;border-color:#66507c;color:#dbc9ef}
html[data-theme=dark] .doc-list>div{background:#392e46}
html[data-theme=dark] .doc-list b{color:#f0e4ff}
html[data-theme=dark] .doc-list small{color:#c8b8d9}
html[data-theme=dark] .doc-list svg,html[data-theme=dark] .doc-list em{color:#bfa3e3}
html[data-theme=dark] .doc-tags span,html[data-theme=dark] .source-tags span{background:#463652;border-color:#6c557e;color:#e1cfef}
html[data-theme=dark] .doc-tags span:first-child{background:#604084;border-color:#9771bc;color:#f4e8ff}
html[data-theme=dark] .scene-note{background:#382c48f5;border-color:#735987}
html[data-theme=dark] .scene-note b{color:#f0e5ff}
html[data-theme=dark] .scene-note small{color:#ccb9df}
html[data-theme=dark] .chart-kpis>div{background:#3a2d49;border-color:#594468}
html[data-theme=dark] .chart-kpis small{color:#c4b1d9}
html[data-theme=dark] .chart-kpis b{color:#ecddff}
html[data-theme=dark] .scene-chart{background:#34283f}
html[data-theme=dark] .chart-title{color:#e2d1f0}
html[data-theme=dark] .chart-title span,html[data-theme=dark] .chart-bars small{color:#c8b7dc}
html[data-theme=dark] .chart-bars{border-color:#634d76}
html[data-theme=dark] .scene-chip,html[data-theme=dark] .storyfoot{color:#c9bbdf}
html[data-theme=dark] .brand small,html[data-theme=dark] .intro>p,html[data-theme=dark] .feature p{color:#b9b8d7}
html[data-theme=dark] .form-head p{color:#b9b3d0}
html[data-theme=dark] .support,html[data-theme=dark] .formfoot{color:#b8adcd}
html[data-theme=dark] .support button{color:#c5a5ff}
html[data-theme=dark] .input>svg,html[data-theme=dark] .eye{color:#c3afd8}
html[data-theme=dark] input::placeholder{color:#b7a8ca}
html[data-theme=dark] .landscape{opacity:.3}
html[data-theme=dark] .art-glow{opacity:.35}
html[data-theme=dark] .ground{opacity:.22}
html[data-theme=dark] .ring{opacity:.4}
html[data-theme=dark] .carousel-motion{background:#3c2c4d;border-color:#775d8c;color:#ecddff;opacity:1}
html[data-theme=dark] .dots button{background:#6b587f}
html[data-theme=dark] .dots button[aria-pressed=true]{background:#bd91ff}

/* The panel gradients cross-fade through an overlay; content remains live. */
.story,html[data-theme=dark] .story{background:radial-gradient(ellipse at 94% 54%,#d9e2ff8c,transparent 55%),linear-gradient(130deg,#fcfcff 5%,#f1f2ff 65%,#e9edff)}
/* Keep the divider inside the fading surface: an immediate border change left
   a bright seam while the adjacent panels were still transitioning. */
.story,html[data-theme=dark] .story{border-right:0}
.story::after{content:'';position:absolute;top:0;right:0;bottom:0;width:1px;z-index:4;pointer-events:none;background-color:#e3e5f3;transition:background-color 1s cubic-bezier(.4,0,.2,1)}
html[data-theme=dark] .story::after{background-color:#38324c}
.story::before{content:'';position:absolute;inset:0;z-index:0;pointer-events:none;background:radial-gradient(ellipse at 70% 70%,#3d356b,transparent 70%),#222035;opacity:0;transition:opacity 1s cubic-bezier(.4,0,.2,1)}
html[data-theme=dark] .story::before{opacity:1}
.story>.brand,.story>.intro,.story>.features,.story>.illustration,.story>.storyfoot{z-index:1}
.login,html[data-theme=dark] .login{background:radial-gradient(ellipse at 90% 0%,#f9f9ff,transparent 60%),#fff}
.login::before{content:'';position:absolute;inset:0;pointer-events:none;z-index:0;background:#191724;opacity:0;transition:opacity 1s cubic-bezier(.4,0,.2,1)}
html[data-theme=dark] .login::before{opacity:1}
.login>.formwrap,.login>.formfoot{position:relative;z-index:1}
.login>.theme-switch{z-index:3}
body,.brand small,.intro>p,.feature p,.form-head p,.support,.support button,.formfoot,.storyfoot,.scene-chip,.dash-brand,.dash-sidebar,.scene-heading,.doc-list b,.doc-list small,.doc-list svg,.chart-title,.chart-title span,.chart-bars small,.chart-kpis small,.chart-kpis b,.scene-note b,.scene-note small,.float-card b,.float-card small,label{transition:color .8s ease}
.dashboard,.dash-main,.ask,.tile,.doc-search,.doc-list>div,.doc-tags span,.source-tags span,.scene-badge,.scene-chart,.chart-kpis>div,.carousel-motion{transition:background-color 1s ease,border-color .8s ease,color .8s ease,box-shadow .8s ease}
.float-card,.scene-note,.document-board,.analysis-board{transition:background-color 1s ease,border-color .8s ease,color .8s ease}
.landscape,.art-glow,.ground,.ring{transition:opacity 1s ease}
input{transition:background-color 1s ease,color .8s ease,border-color .3s ease,box-shadow .25s ease}

/* A sliding thumb and gently rotating sun/moon stay visible during the fade. */
.theme-switch{isolation:isolate;width:88px;height:42px;padding:4px;gap:4px;border-radius:999px;background:#f0edf7;border:0;animation:login-theme-enter .55s cubic-bezier(.2,.7,.3,1) both;animation-delay:.1s;transition:background-color .8s ease,box-shadow .5s ease;box-shadow:inset 0 0 0 1px #e7e0f1,0 2px 10px #7e64ac05}
.theme-switch::before{content:'';position:absolute;left:4px;top:4px;width:38px;height:34px;border-radius:999px;z-index:0;background:#fff;box-shadow:0 1px 5px #5d49771a;transform:translateX(0);transition:transform .55s cubic-bezier(.22,.8,.28,1),background-color .8s ease,box-shadow .8s ease}
html[data-theme=dark] .theme-switch{background:#30263c;box-shadow:inset 0 0 0 1px #54405e,0 2px 10px #08050f14}
html[data-theme=dark] .theme-switch::before{transform:translateX(42px);background:#66477e;box-shadow:0 2px 8px #08050f22}
.theme-switch button{position:relative;z-index:1;width:38px;height:34px;border-radius:999px;display:grid;place-items:center;padding:0;transition:color .5s ease,transform .55s cubic-bezier(.22,.8,.28,1);background:transparent;box-shadow:none}
.theme-switch button svg{width:19px;height:19px}
.theme-switch button.active,.theme-switch button[aria-pressed=true],html[data-theme=dark] .theme-switch button.active,html[data-theme=dark] .theme-switch button[aria-pressed=true]{background:transparent;box-shadow:none}
.theme-switch button:first-child{transform:rotate(0deg) scale(1.06)}
.theme-switch button:last-child{transform:rotate(25deg) scale(.88)}
html[data-theme=dark] .theme-switch button:first-child{transform:rotate(80deg) scale(.88);color:#aa98be}
html[data-theme=dark] .theme-switch button:last-child{transform:rotate(-15deg) scale(1.06);color:#f4e4ff}
.theme-switch button:active{scale:.88}
.eye [data-eye-slash]{stroke-dasharray:26;stroke-dashoffset:26;opacity:0;transition:stroke-dashoffset .2s ease,opacity .15s ease}
.eye[aria-pressed=true] [data-eye-slash]{stroke-dashoffset:0;opacity:1}
.eye[aria-pressed=true]{color:#8763b3}
html[data-theme=dark] .eye[aria-pressed=true]{color:#dcc4f5}
html[data-theme=dark] .eye:hover,html[data-theme=dark] .eye:focus-visible{background:#483358;color:#f0deff}
@keyframes login-theme-enter{from{opacity:0;translate:0 -8px;scale:.94}to{opacity:1;translate:0 0;scale:1}}
.intro-copy-typing{position:relative}
.intro-copy-typing .intro-copy-layout{opacity:0;display:grid;pointer-events:none;user-select:none}
.intro-copy-layout>span{grid-area:1/1;display:block}
.intro-copy-accessible{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.intro-copy-animated{position:absolute;inset:0 auto auto 0;width:100%;pointer-events:none;user-select:none;opacity:1;transition:opacity .18s ease}
.intro-copy-animated.is-clearing{opacity:0}
.intro-copy-paused .intro-copy-animated::after{animation-play-state:paused}
.intro-copy-animated::after{content:'';display:inline-block;width:2px;height:1em;margin-left:2px;background:currentColor;vertical-align:-.12em;animation:login-copy-cursor .9s step-end infinite}
@keyframes login-copy-cursor{0%,100%{opacity:.75}50%{opacity:0}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
@media(prefers-reduced-motion:reduce){.intro-copy-animated::after{display:none}}
`;
