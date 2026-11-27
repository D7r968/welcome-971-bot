'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { joinVoiceChannel, getVoiceConnection } = require('@discordjs/voice');
const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
  SlashCommandBuilder,
  REST,
  Routes
} = require('discord.js');

const P = PermissionFlagsBits;
const DEFAULT_GIF = path.join(__dirname, 'welcome.gif');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const VOICE_FILE = path.join(__dirname, 'voice-state.json');

/* ── GitHub (حفظ الإعدادات والحالة بشكل دائم) ── */
const GH_TOKEN = String(process.env.GH_TOKEN || '').trim();
const GH_OWNER = process.env.GH_OWNER || 'D7r968';
const GH_REPO = process.env.GH_REPO || 'welcome-971-bot';
const GH_API = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/`;

function ghHeaders() {
  return {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'welcome-971-bot',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function ghGet(rel) {
  const r = await fetch(GH_API + encodeURIComponent(rel), { headers: ghHeaders() });
  if (!r.ok) return null;
  return r.json();
}

async function ghPut(rel, buf, sha) {
  const res = await fetch(GH_API + encodeURIComponent(rel), {
    method: 'PUT',
    headers: ghHeaders(),
    body: JSON.stringify({
      message: `bot: update ${rel}`,
      content: Buffer.from(buf).toString('base64'),
      ...(sha ? { sha } : {}),
      branch: 'main'
    })
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/* ── الإعدادات الافتراضية ── */
const DEFAULTS = {
  serverName: '« Group |  EXPLOSIVE 971 »',
  template: 'أهلاً بك {user} في سيرفر {server}!',
  subtext: 'نورتنا',
  dm: 'هلا بك منور ي عسل',
  color: '#FF8C00',
  channelId: null,
  image: 'welcome.gif',
  welcomeEnabled: true,
  dmEnabled: true,
  dmImageEnabled: true
};

function readLocalJson(file) {
  try {
    const x = JSON.parse(fs.readFileSync(file, 'utf8'));
    return x && typeof x === 'object' ? x : {};
  } catch {
    return {};
  }
}

let configs = readLocalJson(CONFIG_FILE);
let voiceState = readLocalJson(VOICE_FILE);

function getConfig(guildId) {
  return { ...DEFAULTS, ...(configs[guildId] || {}) };
}

async function persistJson(file, obj, rel) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { console.error('[!] حفظ محلي:', e.message); }
  if (!GH_TOKEN) return;
  try {
    const cur = await ghGet(rel);
    await ghPut(rel, Buffer.from(JSON.stringify(obj, null, 2), 'utf8'), cur?.sha);
  } catch (e) {
    console.warn(`[!] فشل حفظ ${rel} في GitHub: ${e.message}`);
  }
}

async function setConfig(guildId, cfg) {
  configs[guildId] = cfg;
  await persistJson(CONFIG_FILE, configs, 'config.json');
}

async function saveVoice() {
  await persistJson(VOICE_FILE, voiceState, 'voice-state.json');
}

async function loadPersisted() {
  if (!GH_TOKEN) return;
  for (const rel of ['config.json', 'voice-state.json']) {
    try {
      const j = await ghGet(rel);
      if (j?.content) {
        const obj = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
        if (obj && typeof obj === 'object') {
          if (rel === 'config.json') { configs = { ...configs, ...obj }; fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2)); }
          else { voiceState = { ...voiceState, ...obj }; fs.writeFileSync(VOICE_FILE, JSON.stringify(voiceState, null, 2)); }
        }
      }
    } catch (e) {
      console.warn(`[!] فشل قراءة ${rel} من GitHub: ${e.message}`);
    }
  }
  console.log('[✓] تم تحميل الإعدادات وحالة الروم من GitHub');
}

/* ── خادم الصحة (self-ping) ── */
const app = express();
app.get('/', (_req, res) => res.json({ status: 'ok', bot: 'بوت ترحيب (971)' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => console.log(`[web] health server on ${PORT}`));

const selfUrl = String(process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
if (selfUrl) {
  setInterval(() => fetch(selfUrl + '/health').catch(() => {}), 5 * 60 * 1000).unref();
  console.log('[web] self ping → ' + selfUrl);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates
  ]
});

/* ── أدوات مساعدة ── */
function render(str, vars) {
  return String(str == null ? '' : str)
    .split('{user}').join(vars.user)
    .split('{mention}').join(vars.user)
    .split('{server}').join(vars.server)
    .split('{name}').join(vars.name)
    .split('{tag}').join(vars.tag);
}

function safeColor(hex) {
  try { return new EmbedBuilder().setColor(String(hex || DEFAULTS.color)).data.color; }
  catch { return 0xFF8C00; }
}

function imageInfo(cfg) {
  const wanted = path.basename(String(cfg.image || 'welcome.gif'));
  let p = path.join(__dirname, wanted);
  if (!fs.existsSync(p)) p = DEFAULT_GIF;
  return { p, name: path.basename(p) };
}

function fileFor(cfg) {
  const { p, name } = imageInfo(cfg);
  return new AttachmentBuilder(p, { name });
}

function canSend(ch, me) {
  if (!ch || !ch.isTextBased()) return false;
  const perms = ch.permissionsFor(me);
  return !!perms && perms.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles]);
}

function pickWelcomeChannel(guild, forcedId) {
  const me = guild.members.me;
  if (!me) return null;
  const forced = String(forcedId || process.env.WELCOME_CHANNEL_ID || '').trim();
  if (forced) {
    const ch = guild.channels.cache.get(forced);
    if (canSend(ch, me)) return ch;
    console.warn('[!] القناة المحدّدة ما قدرت أرسل فيها — بنختار قناة تانية');
  }
  if (canSend(guild.systemChannel, me)) return guild.systemChannel;
  const byName = guild.channels.cache.find((ch) => canSend(ch, me) && /welcome|ترحيب|أهلا|اهلا|استقبال/i.test(ch.name));
  if (byName) return byName;
  const general = guild.channels.cache.find((ch) => canSend(ch, me) && /general|public|عام/i.test(ch.name));
  if (general) return general;
  return guild.channels.cache.find((ch) => canSend(ch, me)) || null;
}

function buildWelcome(user, guild, cfg) {
  const mention = `<@${user.id}>`;
  const vars = {
    user: mention,
    server: cfg.serverName,
    name: user.username || user.displayName || '',
    tag: user.tag || ''
  };
  const { name: imgName } = imageInfo(cfg);
  const description = render(cfg.subtext ? `${cfg.subtext} {user}` : '{user}', vars);
  const embed = new EmbedBuilder()
    .setColor(safeColor(cfg.color))
    .setAuthor({ name: guild.name, iconURL: guild.iconURL({ dynamic: true, size: 128 }) || undefined })
    .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 256 }))
    .setDescription(description)
    .setImage(`attachment://${imgName}`)
    .setFooter({ text: user.tag || guild.name })
    .setTimestamp();
  return {
    content: render(cfg.template, vars) + (cfg.subtext ? `\n${cfg.subtext}` : ''),
    embed,
    dm: render(cfg.dm, vars)
  };
}

async function welcomeMember(member) {
  const cfg = getConfig(member.guild.id);
  if (!cfg.welcomeEnabled) return;

  const channel = pickWelcomeChannel(member.guild, cfg.channelId);
  if (!channel) {
    console.warn(`[!] ما لقيت قناة أرسل فيها الترحيب في ${member.guild.name}`);
    return;
  }

  const built = buildWelcome(member.user, member.guild, cfg);
  try {
    await channel.send({
      content: built.content,
      allowedMentions: { parse: ['users'] },
      embeds: [built.embed],
      files: [fileFor(cfg)]
    });
    console.log(`[✓] رحّبت بـ ${member.user.tag} في ${channel.name} / ${member.guild.name}`);
  } catch (err) {
    console.error('[!] فشل إرسال الترحيب:', err.message);
  }

  if (!cfg.dmEnabled) return;
  try {
    const dmPayload = { content: built.dm };
    if (cfg.dmImageEnabled) dmPayload.files = [fileFor(cfg)];
    await member.send(dmPayload);
    console.log(`[✓] أرسلت رسالة الخاص لـ ${member.user.tag}`);
  } catch (err) {
    console.warn(`[i] ما وصلت رسالة الخاص لـ ${member.user.tag}: ${err.message}`);
  }
}

/* ── أوامر الصوت / ── */
function buildCommands() {
  const welcome = new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('إعداد رسالة الترحيب بالكامل (أدمن فقط)')

    .addSubcommand((s) => s.setName('text').setDescription('عدّل نص الترحيب')
      .addStringOption((o) => o.setName('template').setDescription('النص الأساسي — {user} = منشن، {server} = اسم السيرفر').setRequired(true))
      .addStringOption((o) => o.setName('subtext').setDescription('السطر الثاني (مثال: نورتنا) — اتركه فاضي عشان ما يتعدّل')))

    .addSubcommand((s) => s.setName('dm').setDescription('عدّل رسالة الخاص')
      .addStringOption((o) => o.setName('text').setDescription('نص الخاص — يدعم {user} و {server}').setRequired(true)))

    .addSubcommand((s) => s.setName('dmimage').setDescription('فعّل أو عطّل الصورة في رسالة الخاص')
      .addBooleanOption((o) => o.setName('enabled').setDescription('true = الصورة تجي مع الخاص / false = بدون صورة').setRequired(true)))

    .addSubcommand((s) => s.setName('image').setDescription('ارفع صورة/GIF الترحيب')
      .addAttachmentOption((o) => o.setName('file').setDescription('الملف (GIF أو صورة، حتى 10MB)').setRequired(true)))

    .addSubcommand((s) => s.setName('color').setDescription('عدّل لون الإمbed')
      .addStringOption((o) => o.setName('hex').setDescription('مثل #FF8C00').setRequired(true)))

    .addSubcommand((s) => s.setName('channel').setDescription('حدّد قناة الترحيب')
      .addChannelOption((o) => o.setName('channel').setDescription('القناة اللي توصل فيها الترحيب').setRequired(true)))

    .addSubcommand((s) => s.setName('servername').setDescription('عدّل اسم السيرفر الظاهر في الرسالة')
      .addStringOption((o) => o.setName('name').setDescription('الاسم — مثال: « Group |  EXPLOSIVE 971 »').setRequired(true)))

    .addSubcommand((s) => s.setName('toggle').setDescription('فعّل أو عطّل الترحيب / الخاص')
      .addStringOption((o) => o.setName('target').setDescription('حدد أي جزء').setRequired(true)
        .addChoices(
          { name: 'الترحيب في القناة', value: 'welcome' },
          { name: 'رسالة الخاص', value: 'dm' }
        ))
      .addBooleanOption((o) => o.setName('enabled').setDescription('true = تفعيل / false = تعطيل').setRequired(true)))

    .addSubcommand((s) => s.setName('preview').setDescription('اعرض كل الإعدادات الحالية'))

    .addSubcommand((s) => s.setName('test').setDescription('أرسل ترحيب تجريبي في القناة'))

    .addSubcommand((s) => s.setName('reset').setDescription('أعد كل الإعدادات للوضع الافتراضي'));

  const join = new SlashCommandBuilder()
    .setName('join')
    .setDescription('أدخل البوت في الروم الصوتي وخليه جالس فيه')
    .addChannelOption((o) =>
      o.setName('channel').setDescription('القناة الصوتية (اتركها فاضية عشان يدخل رومك أنت)').setRequired(false));

  const leave = new SlashCommandBuilder()
    .setName('leave')
    .setDescription('أخرج البوت من الروم الصوتي');

  const status = new SlashCommandBuilder()
    .setName('status')
    .setDescription('اعرض حالة البوت في الروم الصوتي');

  return [welcome, join, leave, status].map((c) => c.setDefaultMemberPermissions(P.Administrator).toJSON());
}

async function registerCommands() {
  const token = String(process.env.DISCORD_TOKEN || '').trim();
  if (!token || !client.user) return;
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    const cmds = buildCommands();
    await rest.put(Routes.applicationCommands(client.user.id), { body: cmds });
    console.log('[✓] تم تسجيل الأوامر عالمياً (/welcome, /join, /leave, /status)');
    for (const guild of client.guilds.cache.values()) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: cmds });
        console.log(`[✓] الأوامر جاهزة فوراً في ${guild.name}`);
      } catch (e) {
        console.warn(`[!] ما تسجّلت الأوامر في ${guild.name}: ${e.message}`);
      }
    }
  } catch (err) {
    console.error('[!] فشل تسجيل الأوامر:', err.message);
  }
}

/* ── أوامر إعداد الترحيب ── */
function ephem(interaction, content) {
  return interaction.reply({ content, flags: 64 });
}

async function saveImage(attachment) {
  const max = 10 * 1024 * 1024;
  if (attachment.size && attachment.size > max) throw new Error('الملف أكبر من 10MB');
  if (attachment.contentType && !attachment.contentType.startsWith('image/')) throw new Error('الملف مو صورة');
  const ext = path.extname(attachment.name || '').toLowerCase();
  const allowed = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];
  const useExt = allowed.includes(ext) ? ext : '.gif';
  const name = `welcome-${Date.now()}${useExt}`;
  const r = await fetch(attachment.url);
  if (!r.ok) throw new Error('ما قدرت أنزّل المرفق');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > max) throw new Error('الملف أكبر من 10MB');

  fs.writeFileSync(path.join(__dirname, name), buf);
  if (GH_TOKEN) {
    try { await ghPut(name, buf); }
    catch (e) { console.warn(`[!] فشل رفع الصورة لـ GitHub: ${e.message}`); }
  }
  return name;
}

async function handleWelcome(interaction) {
  const guild = interaction.guild;
  if (!guild) return ephem(interaction, '❌ هذا الأمر يشتغل داخل سيرفر بس.');
  if (!interaction.memberPermissions?.has(P.Administrator)) {
    return ephem(interaction, '❌ الأدمن فقط يقدر يعدّل إعدادات الترحيب.');
  }

  const sub = interaction.options.getSubcommand();
  const cfg = getConfig(guild.id);

  switch (sub) {
    case 'text': {
      cfg.template = interaction.options.getString('template', true);
      const st = interaction.options.getString('subtext');
      if (st !== null) cfg.subtext = st;
      await setConfig(guild.id, cfg);
      return ephem(interaction, `✅ تم تحديث النص:\n\`\`\`${cfg.template}\n${cfg.subtext}\`\`\`\nالمتغيرات: \`{user}\` \`{server}\` \`{name}\``);
    }

    case 'dm': {
      cfg.dm = interaction.options.getString('text', true);
      await setConfig(guild.id, cfg);
      return ephem(interaction, `✅ تم تحديث رسالة الخاص إلى:\n\`\`\`${cfg.dm}\`\`\``);
    }

    case 'image': {
      const att = interaction.options.getAttachment('file', true);
      try {
        const name = await saveImage(att);
        cfg.image = name;
        await setConfig(guild.id, cfg);
        return ephem(interaction, `✅ تم تحديث صورة الترحيب إلى \`${name}\` (محفوظة في GitHub).`);
      } catch (e) {
        return ephem(interaction, `❌ فشل رفع الصورة: ${e.message}`);
      }
    }

    case 'color': {
      const hex = interaction.options.getString('hex', true);
      const test = new EmbedBuilder().setColor(hex);
      if (!test.data.color) return ephem(interaction, '❌ اللون غير صالح — استخدم هيكس مثل #FF8C00');
      cfg.color = hex;
      await setConfig(guild.id, cfg);
      return ephem(interaction, `✅ تم تحديث اللون إلى \`${hex}\`.`);
    }

    case 'channel': {
      const ch = interaction.options.getChannel('channel', true);
      if (!ch.isTextBased()) return ephem(interaction, '❌ اختر قناة نصية.');
      cfg.channelId = ch.id;
      await setConfig(guild.id, cfg);
      return ephem(interaction, `✅ قناة الترحيب صارت <#${ch.id}>.`);
    }

    case 'servername': {
      cfg.serverName = interaction.options.getString('name', true);
      await setConfig(guild.id, cfg);
      return ephem(interaction, `✅ الاسم الظاهر في الرسالة صار: ${cfg.serverName}`);
    }

    case 'dmimage': {
      cfg.dmImageEnabled = interaction.options.getBoolean('enabled', true);
      await setConfig(guild.id, cfg);
      return ephem(interaction, `✅ صورة رسالة الخاص صارت ${cfg.dmImageEnabled ? 'مفعّلة (تجي مع الخاص)' : 'معطّلة (الخاص بدون صورة)'}.`);
    }

    case 'toggle': {
      const target = interaction.options.getString('target', true);
      const enabled = interaction.options.getBoolean('enabled', true);
      if (target === 'welcome') cfg.welcomeEnabled = enabled;
      else cfg.dmEnabled = enabled;
      await setConfig(guild.id, cfg);
      return ephem(interaction, `✅ ${target === 'welcome' ? 'الترحيب في القناة' : 'رسالة الخاص'} صار ${enabled ? 'مفعّل' : 'معطّل'}.`);
    }

    case 'preview': {
      const ch = cfg.channelId ? guild.channels.cache.get(cfg.channelId) : pickWelcomeChannel(guild, null);
      const text =
        `⚙️ **إعدادات الترحيب — ${guild.name}**\n\n` +
        `• الحالة: ${cfg.welcomeEnabled ? 'مفعّل ✅' : 'معطّل ❌'}\n` +
        `• الخاص: ${cfg.dmEnabled ? 'مفعّل ✅' : 'معطّل ❌'}\n` +
        `• صورة الخاص: ${cfg.dmImageEnabled !== false ? 'مفعّلة ✅' : 'معطّلة ❌'}\n` +
        `• القناة: ${ch ? `<#${ch.id}>` : 'تلقائي'}\n` +
        `• الاسم الظاهر: ${cfg.serverName}\n` +
        `• النص: \`${cfg.template}\`\n` +
        `• السطر الثاني: \`${cfg.subtext || '(فارغ)'}\`\n` +
        `• الخاص: \`${cfg.dm}\`\n` +
        `• اللون: \`${cfg.color}\`\n` +
        `• الصورة: \`${cfg.image}\`\n\n` +
        `للتعديل اكتب \`/welcome\` واختر البند المطلوب.`;
      return ephem(interaction, text);
    }

    case 'test': {
      const channel = pickWelcomeChannel(guild, cfg.channelId);
      if (!channel) return ephem(interaction, '❌ ما لقيت قناة أرسل فيها الاختبار.');
      const built = buildWelcome(interaction.user, guild, cfg);
      try {
        await channel.send({
          content: built.content,
          allowedMentions: { parse: ['users'] },
          embeds: [built.embed],
          files: [fileFor(cfg)]
        });
        if (cfg.dmEnabled) {
          const dmPayload = { content: built.dm };
          if (cfg.dmImageEnabled) dmPayload.files = [fileFor(cfg)];
          await interaction.user.send(dmPayload).catch(() => {});
        }
        return ephem(interaction, `✅ أرسلت ترحيب تجريبي في <#${channel.id}>.`);
      } catch (e) {
        return ephem(interaction, `❌ فشل الاختبار: ${e.message}`);
      }
    }

    case 'reset': {
      configs[guild.id] = { ...DEFAULTS };
      await setConfig(guild.id, configs[guild.id]);
      return ephem(interaction, '✅ تمت إعادة كل الإعدادات للوضع الافتراضي.');
    }
  }
}

/* ── أوامر الصوت ── */
function joinVoice(guild, channel, actorTag) {
  if (!channel || !channel.isVoiceBased()) return false;
  const me = guild.members.me;
  if (me) {
    const perms = channel.permissionsFor(me);
    if (perms && (!perms.has(P.Connect) || !perms.has(P.Speak))) return false;
  }
  const existing = getVoiceConnection(guild.id);
  if (existing && existing.joinConfig.channelId === channel.id) {
    voiceState[guild.id] = { channelId: channel.id, enabled: true };
    saveVoice();
    return true;
  }
  if (existing) existing.destroy();
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false
  });
  connection.on('error', (err) => console.error('[!] خطأ في الاتصال الصوتي:', err.message));
  voiceState[guild.id] = { channelId: channel.id, enabled: true };
  saveVoice();
  console.log(`[✓] البوت جالس في الروم ${channel.name} / ${guild.name}${actorTag ? ' — بدطلب من ' + actorTag : ''}`);
  return true;
}

function leaveVoice(guild) {
  const connection = getVoiceConnection(guild.id);
  if (connection) connection.destroy();
  voiceState[guild.id] = { channelId: null, enabled: false };
  saveVoice();
}

async function handleVoice(interaction) {
  const guild = interaction.guild;
  if (!guild) return ephem(interaction, '❌ هذا الأمر يشتغل داخل سيرفر بس.');

  if (interaction.commandName === 'join') {
    const option = interaction.options.getChannel('channel');
    const channel = option || interaction.member?.voice?.channel || null;
    if (!channel || !channel.isVoiceBased()) {
      return ephem(interaction, '❌ أدخل روم صوتي أول أو حدّد قناة بالأمر، ثم جرّب /join');
    }
    const ok = joinVoice(guild, channel, interaction.user.tag);
    return ephem(interaction, ok
      ? `✅ البوت صار جالس في <#${channel.id}> — بيبقى فيه طول ما البوت شغال، ويرجع لحاله لو انقطع.`
      : '❌ ما قدر أدخل الروم — تأكد إن البوت عنده صلاحية Connect / Speak وأن الروم ليس ممتلئاً.');
  }

  if (interaction.commandName === 'leave') {
    leaveVoice(guild);
    return ephem(interaction, '✅ طلعت من الروم الصوتي.');
  }

  if (interaction.commandName === 'status') {
    const connection = getVoiceConnection(guild.id);
    const chId = connection?.joinConfig?.channelId || voiceState[guild.id]?.channelId;
    const ch = chId ? guild.channels.cache.get(chId) : null;
    return ephem(interaction, ch
      ? `🔊 البوت جالس في <#${ch.id}> (${ch.name}) — محفوظ: ${voiceState[guild.id]?.enabled ? 'نعم' : 'لا'}`
      : '🔇 البوت ما جالس في أي روم حالياً.');
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`[✓] مسجّل دخول كـ ${c.user.tag}`);
  console.log(`[i] السيرفرات: ${c.guilds.cache.size}`);
  for (const g of c.guilds.cache.values()) console.log(`   - ${g.name} (${g.id})`);

  await loadPersisted();
  registerCommands();

  for (const [gid, st] of Object.entries(voiceState)) {
    if (!st.enabled || !st.channelId) continue;
    const guild = c.guilds.cache.get(gid);
    const ch = guild?.channels.cache.get(st.channelId);
    if (guild && ch && ch.isVoiceBased()) joinVoice(guild, ch);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  // كل أوامر / مقتصرة على الأدمن (أي رتبة فيها صلاحية Administrator)
  const allowed = interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    interaction.user.id === interaction.guild?.ownerId;
  if (!allowed) {
    return interaction.reply({ content: '❌ أوامر البوت للأدمن فقط.', flags: 64 });
  }
  try {
    if (interaction.commandName === 'welcome') await handleWelcome(interaction);
    else await handleVoice(interaction);
  } catch (err) {
    console.error('[!] خطأ في الأمر:', err);
    const msg = '❌ صار خطأ في الأمر.';
    if (interaction.replied || interaction.deferred) await interaction.followUp({ content: msg, flags: 64 }).catch(() => {});
    else await ephem(interaction, msg).catch(() => {});
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try { await welcomeMember(member); }
  catch (err) { console.error('[!] خطأ في حدث الدخول:', err); }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.member?.id !== client.user?.id) return;
  if (oldState.channelId && !newState.channelId) {
    const st = voiceState[newState.guild.id];
    if (!st?.enabled || !st.channelId) return;
    setTimeout(() => {
      const guild = client.guilds.cache.get(newState.guild.id);
      const ch = guild?.channels.cache.get(st.channelId);
      if (guild && ch && ch.isVoiceBased()) joinVoice(guild, ch);
    }, 3000);
  }
});

client.on(Events.Error, (err) => console.error('[!] خطأ في الاتصال:', err.message));

process.on('SIGTERM', () => {
  console.log('[i] SIGTERM — إغلاق آمن...');
  client.destroy();
  process.exit(0);
});

const token = String(process.env.DISCORD_TOKEN || '').trim();
if (!token) {
  console.error('[!] DISCORD_TOKEN غير مضبوط');
} else {
  async function startLogin() {
    try {
      await client.login(token);
      console.log('[✓] تم تسجيل الدخول بنجاح');
    } catch (err) {
      console.error('[!] فشل تسجيل الدخول (' + err.message + ') — إعادة المحاولة خلال 30 ثانية...');
      setTimeout(startLogin, 30000);
    }
  }
  startLogin();
}
