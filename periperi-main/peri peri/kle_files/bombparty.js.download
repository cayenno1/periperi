'use strict';

// Text
let hasLoadedText = false;

loadText('/games/bombparty/text', navigator.language, () => {
  hasLoadedText = true;

  if (milestone != null) {
    $hide('.loading');
    $show('.main');
  }
});

// Audio
jklmAudio.load({
  start: '/games/bombparty/sounds/ignite.wav',
  selfTurn: '/games/bombparty/sounds/selfTurn.wav',
  failWord: '/games/bombparty/sounds/failWord.wav',
  failWord_alreadyUsed: '/games/bombparty/sounds/failWord_alreadyUsed.wav',
  correctWord: '/games/bombparty/sounds/correctWord.wav',
  explosion: '/games/bombparty/sounds/explosion.wav',
  tick: '/games/bombparty/sounds/tick.wav',
});

// Setup and milestone
let serverToLocalNow = 0;
let constants;
let milestone;
let isBonusAlphabetEdited = false;

let selfPeerId;
let selfRoles = [];
let leaderPeerId;
let players;
let playersByPeerId = {};

socket.on('setup', socket_onSetup);

socket.on('setMilestone', socket_onSetMilestone);
socket.on('setDictionaryManifest', socket_onSetDictionaryManifest);

function renderBonusAlphabet() {
  $('.bonusAlphabetField').innerHTML = '';
  const bonusAlphabet = rules.customBonusAlphabet.value;
  for (const letter in bonusAlphabet) {
    const letterFieldElt = $make('div', $('.bonusAlphabetField'), {
      className: 'letterField',
    });
    $make('label', letterFieldElt, { textContent: letter.toUpperCase() });
    const letterInput = $make('input', letterFieldElt, {
      type: 'number',
      min: '0',
      id: letter,
      value: bonusAlphabet[letter],
    });
    letterInput.addEventListener('change', () => {
      isBonusAlphabetEdited = true;
      $show($('.resetBonusAlphabet'), isBonusAlphabetEdited);
      $show($('.saveBonusAlphabet'), isBonusAlphabetEdited);
    });
  }
}

function socket_onSetup(data) {
  constants = data.constants;
  if (hasLoadedText) {
    $hide('.loading.page');
    $show('.main.page');
  }

  rules = data.rules;
  milestone = data.milestone;
  players = data.players;
  selfPeerId = data.selfPeerId;
  selfRoles = data.selfRoles;
  leaderPeerId = data.leaderPeerId;
  serverToLocalNow = Date.now() - data.serverNow;

  // Rules
  for (const item of rules.dictionaryId.items)
    $make('option', dictionaryIdRuleSelect, {
      textContent: getText(item.label, `dictionaries.${item.value}.name`),
      value: item.value,
    });
  dictionaryIdRuleSelect.value = rules.dictionaryId.value;
  renderBonusAlphabet();

  $('.resetBonusAlphabet').addEventListener('click', e => {
    e.preventDefault();
    for (const letterFieldInput of $$('.letterField input'))
      letterFieldInput.value =
        milestone.dictionaryManifest.bonusAlphabet[letterFieldInput.id];
    $hide($('.resetBonusAlphabet'));
    $show($('.saveBonusAlphabet'));
  });

  $('.saveBonusAlphabet').addEventListener('click', e => {
    e.preventDefault();
    const customBonusAlphabet = {};
    for (const { id, value } of $$('.letterField input'))
      customBonusAlphabet[id] = parseInt(value, 10);
    socket.emit('setRules', { customBonusAlphabet });
    $hide($('.saveBonusAlphabet'));
  });

  $('.bonusAlphabetBulkEdit button').addEventListener('click', e => {
    e.preventDefault();
    const bulkEditValue = $('.bonusAlphabetBulkEdit input').value;
    for (const letterFieldInput of $$('.letterField input'))
      letterFieldInput.value = parseInt(bulkEditValue, 10);
    isBonusAlphabetEdited = true;
    $show($('.resetBonusAlphabet'), isBonusAlphabetEdited);
    $show($('.saveBonusAlphabet'), isBonusAlphabetEdited);
  });

  renderQuickRules();

  $setRangeField(promptDifficultyRuleCustomField, {
    value: 1,
    min: 1,
    max: rules.promptDifficulty.max,
  });
  setupPromptDifficultyPresets();
  setupPromptDifficulty();

  $setRangeField(minTurnDurationRuleField, rules.minTurnDuration);
  $setRangeField(maxPromptAgeRuleField, rules.maxPromptAge);
  $setRangeField(maxPlayersRuleField, rules.maxPlayers);
  $setRangeField(startingLivesRuleField, rules.startingLives);
  $setRangeField(maxLivesRuleField, rules.maxLives);

  if (data.milestone.rulesLocked === false && leaderPeerId === selfPeerId)
    showRules = true;

  // Players
  for (const player of players) {
    playersByPeerId[player.profile.peerId] = player;
    player.image = new Image();
    if (
      player.profile.picture != null &&
      !player.profile.roles.includes('banned')
    )
      player.image.src = `data:image/jpeg;base64,${player.profile.picture}`;
  }

  // Milestone
  renderMilestone();

  animate();
}

function socket_onSetMilestone(newMilestone, serverNow) {
  serverToLocalNow = Date.now() - serverNow;
  animateBackground = null;

  if (milestone.name !== newMilestone.name) {
    switch (milestone.name) {
      case 'round':
        round_exit();
        break;
      case 'seating':
        seating_exit();
        break;
    }

    milestone = newMilestone;

    switch (milestone.name) {
      case 'round':
        round_enter();
        break;
      case 'seating':
        seating_enter();
        break;
    }
  } else {
    milestone = newMilestone;
  }

  renderMilestone();
}

function socket_onSetDictionaryManifest(manifest) {
  milestone.dictionaryManifest = manifest;
  setupPromptDifficultyPresets();
}

function renderMilestone() {
  const isSeating = milestone.name === 'seating';

  $$('.seating').forEach(x => (x.hidden = !isSeating));
  $$('.round').forEach(x => (x.hidden = isSeating));
  applyRulesVisibility();

  if (isSeating) seating_render();
  else round_render();
}

// Rules
let rules;

let showRules = false;
const toggleRulesButton = $('.quickRules button.toggleRules');

toggleRulesButton.addEventListener('click', event => {
  showRules = !showRules;
  applyRulesVisibility();
  const canEditRules =
    (leaderPeerId === selfPeerId || selfRoles.includes('staff')) &&
    milestone.name === 'seating';
  if (canEditRules) socket.emit('setRulesLocked', !showRules);
});

function applyRulesVisibility() {
  const canEditRules =
    (leaderPeerId === selfPeerId || selfRoles.includes('staff')) &&
    milestone.name === 'seating';
  $('.middle .rules fieldset').disabled = !canEditRules;
  $show('.middle .rules', showRules);

  $show('.middle .rules .stats', milestone.name === 'round');

  $show('.quickRules .summary', !showRules);
  $show(
    toggleRulesButton,
    milestone.name !== 'round' || milestone.currentPlayerPeerId !== selfPeerId,
  );
  toggleRulesButton.textContent = showRules
    ? getText('Close rules', 'closeRules')
    : canEditRules
    ? getText('Edit rules', 'editRules')
    : getText('Show rules', 'showRules');
}

const dictionaryIdRuleSelect = $('.rules .dictionaryId.rule select');
const promptDifficultyRulePresetSelect = $(
  '.rules .promptDifficulty.rule .preset select',
);
const promptDifficultyCustomModeSelect = $(
  '.rules .promptDifficulty.rule .custom select',
);

const promptDifficultyRuleCustomField = {
  number: $('.rules .promptDifficulty.rule .custom input[type=number]'),
  range: $('.rules .promptDifficulty.rule .custom input[type=range]'),
};
const minTurnDurationRuleField = {
  number: $('.rules .minTurnDuration.rule input[type=number]'),
  range: $('.rules .minTurnDuration.rule input[type=range]'),
};
const maxPromptAgeRuleField = {
  number: $('.rules .maxPromptAge.rule input[type=number]'),
  range: $('.rules .maxPromptAge.rule input[type=range]'),
};
const maxPlayersRuleField = {
  number: $('.rules .maxPlayers.rule input[type=number]'),
  range: $('.rules .maxPlayers.rule input[type=range]'),
};
const startingLivesRuleField = {
  number: $('.rules .lives.rule input.starting[type=number]'),
  range: $('.rules .lives.rule input.starting + input[type=range]'),
};
const maxLivesRuleField = {
  number: $('.rules .lives.rule input.max[type=number]'),
  range: $('.rules .lives.rule input.max + input[type=range]'),
};
$bindRangeField(promptDifficultyRuleCustomField, emitSetPromptDifficultyRule);
$bindRangeField(minTurnDurationRuleField, () =>
  socket.emit('setRules', {
    minTurnDuration: parseInt(minTurnDurationRuleField.number.value, 10),
  }),
);
$bindRangeField(maxPromptAgeRuleField, () =>
  socket.emit('setRules', {
    maxPromptAge: parseInt(maxPromptAgeRuleField.number.value, 10),
  }),
);
$bindRangeField(maxPlayersRuleField, () =>
  socket.emit('setRules', {
    maxPlayers: parseInt(maxPlayersRuleField.number.value, 10),
  }),
);
$bindRangeField(startingLivesRuleField, () =>
  socket.emit('setRules', {
    startingLives: parseInt(startingLivesRuleField.number.value, 10),
  }),
);
$bindRangeField(maxLivesRuleField, () =>
  socket.emit('setRules', {
    maxLives: parseInt(maxLivesRuleField.number.value, 10),
  }),
);

dictionaryIdRuleSelect.addEventListener('change', event => {
  socket.emit('setRules', { dictionaryId: dictionaryIdRuleSelect.value });
});

promptDifficultyRulePresetSelect.addEventListener('change', event => {
  const useCustom = promptDifficultyRulePresetSelect.value === 'custom';
  $show('.rules .promptDifficulty.rule .custom', useCustom);
  if (useCustom) {
    promptDifficultyCustomModeSelect.value = '1';
    $setRangeField(promptDifficultyRuleCustomField, {
      value: Math.ceil(
        milestone.dictionaryManifest.promptDifficulties.hard / 2,
      ),
    });
  }
  emitSetPromptDifficultyRule();
});

promptDifficultyCustomModeSelect.addEventListener('change', event =>
  emitSetPromptDifficultyRule(),
);

function emitSetPromptDifficultyRule() {
  const useCustom = promptDifficultyRulePresetSelect.value === 'custom';

  const rules = { promptDifficulty: promptDifficultyRulePresetSelect.value };
  if (rules.promptDifficulty === 'custom')
    rules.customPromptDifficulty =
      parseInt(promptDifficultyRuleCustomField.number.value, 10) *
      parseInt(promptDifficultyCustomModeSelect.value, 10);
  socket.emit('setRules', rules);
}

function renderQuickRules() {
  const dictionaryId = rules.dictionaryId.value;
  $('.quickRules .dictionary').textContent = getText(
    rules.dictionaryId.items.find(x => x.value === dictionaryId).label,
    `dictionaries.${rules.dictionaryId.value}.name`,
  );

  const promptDifficultyLevel = rules.promptDifficulty.value;
  const promptDifficulty =
    promptDifficultyLevel === 'custom'
      ? rules.customPromptDifficulty.value
      : milestone.dictionaryManifest.promptDifficulties[promptDifficultyLevel];

  $('.quickRules .wordsPerPrompt').textContent =
    promptDifficulty > 0
      ? `min. ${promptDifficulty}`
      : `max. ${-promptDifficulty}`;
}

socket.on('setRulesLocked', socket_onSetRulesLocked);
socket.on('setRules', socket_onSetRules);

function socket_onSetRulesLocked(locked) {
  milestone.rulesLocked = locked;
  renderMilestone();
}

function socket_onSetRules(data) {
  const isLeaderOrStaff =
    leaderPeerId === selfPeerId || selfRoles.includes('staff');

  for (const [ruleName, value] of Object.entries(data)) {
    rules[ruleName].value = value;

    switch (ruleName) {
      case 'dictionaryId':
        dictionaryIdRuleSelect.value = value;
        renderQuickRules();
        break;
      case 'minTurnDuration':
        $setRangeField(minTurnDurationRuleField, { value });
        break;
      case 'promptDifficulty':
      case 'customPromptDifficulty':
        if (!isLeaderOrStaff) setupPromptDifficulty();
        renderQuickRules();
        break;
      case 'maxPromptAge':
        $setRangeField(maxPromptAgeRuleField, { value });
        break;
      case 'maxPlayers': {
        $setRangeField(maxPlayersRuleField, { value });
        $show('.joinRound', players.length < value);
        $show('.gameFull', players.length >= value);
        break;
      }
      case 'startingLives':
        $setRangeField(startingLivesRuleField, { value });
        break;
      case 'maxLives':
        $setRangeField(maxLivesRuleField, { value });
        break;
      case 'customBonusAlphabet':
        renderBonusAlphabet();
        break;
    }
  }
}

function setupPromptDifficultyPresets() {
  const { promptDifficulties } = milestone.dictionaryManifest;
  $(promptDifficultyRulePresetSelect, `option[value="beginner"]`).textContent =
    getText(`Beginner (at least {words} words per prompt)`, 'presetBeginner', {
      words: promptDifficulties.beginner,
    });
  $(promptDifficultyRulePresetSelect, `option[value="medium"]`).textContent =
    getText(`Medium (at least {words} words per prompt)`, 'presetMedium', {
      words: promptDifficulties.medium,
    });
  $(promptDifficultyRulePresetSelect, `option[value="hard"]`).textContent =
    getText(`Hard (at least {words} words per prompt)`, 'presetHard', {
      words: promptDifficulties.hard,
    });
}

function setupPromptDifficulty() {
  const promptDifficultyLevel = rules.promptDifficulty.value;
  promptDifficultyRulePresetSelect.value = promptDifficultyLevel;

  $show(
    '.rules .promptDifficulty.rule .custom',
    promptDifficultyLevel === 'custom',
  );

  const promptDifficulty =
    promptDifficultyLevel === 'custom'
      ? rules.customPromptDifficulty.value
      : milestone.dictionaryManifest.promptDifficulties[promptDifficultyLevel];
  promptDifficultyCustomModeSelect.value = promptDifficulty > 0 ? '1' : '-1';
  $setRangeField(promptDifficultyRuleCustomField, {
    value: Math.abs(promptDifficulty),
  });
}

// Players

socket.on('addPlayer', socket_onAddPlayer);
socket.on('updatePlayer', socket_onUpdatePlayer);
socket.on('removePlayer', socket_onRemovePlayer);
socket.on('setLeaderPeer', socket_onSetLeaderPeer);

function socket_onAddPlayer(player) {
  players.push(player);
  playersByPeerId[player.profile.peerId] = player;
  player.image = new Image();
  if (player.profile.picture != null && !player.profile.roles.includes('banned'))
    player.image.src = `data:image/jpeg;base64,${player.profile.picture}`;
  player.animation = { type: 'join', startTime: Date.now(), duration: 300 };

  renderMilestone();
}

function socket_onUpdatePlayer(playerPeerId, profile, isOnline) {
  const player = playersByPeerId[playerPeerId];
  player.profile = profile;
  player.isOnline = isOnline;
  renderMilestone();
}

function socket_onRemovePlayer(playerPeerId) {
  const player = playersByPeerId[playerPeerId];
  players.splice(players.indexOf(player), 1);
  delete playersByPeerId[playerPeerId];
  renderMilestone();
}

function socket_onSetLeaderPeer(peerId) {
  leaderPeerId = peerId;
  if (leaderPeerId === selfPeerId) socket.emit('setRulesLocked', !showRules);
  if (milestone.name === 'seating') seating_render();
}

// Seating
$('.top .seating .startRoundNow a').addEventListener(
  'click',
  startRoundNow_onClick,
);
$('button.joinRound').addEventListener('click', joinRound_onClick);
$('button.leaveRound').addEventListener('click', leaveRound_onClick);

function startRoundNow_onClick(event) {
  socket.emit('startRoundNow');
}

function joinRound_onClick(event) {
  event.preventDefault();
  socket.emit('joinRound');
}

function leaveRound_onClick(event) {
  event.preventDefault();
  socket.emit('leaveRound');
}

function seating_enter() {}

function seating_exit() {}

function seating_render() {
  if (tickSource != null) {
    tickSource.stop();
    tickSource = null;
  }

  $show('.top');

  renderSeatingStatus();

  $show('.middle .seating .lastRound', milestone.lastRound != null);
  if (milestone.lastRound != null) {
    const { winner } = milestone.lastRound;
    $('.middle .seating .lastRound .winnerPicture img').src =
      winner.picture == null
        ? '/images/auth/guest.png'
        : `data:image/jpeg;base64,${winner.picture}`;
    $('.middle .seating .lastRound .winnerNickname').textContent =
      winner.nickname;
  }

  const joined = playersByPeerId[selfPeerId] != null;
  $show('.bottom .seating .join', !joined);
  $show('.joinRound', players.length < rules.maxPlayers.value);
  $show('.gameFull', players.length >= rules.maxPlayers.value);
  $show('.bottom .seating .joined', joined);

  wasSelfTurn = false;
}

function renderSeatingStatus() {
  const statusElt = $('.top .seating .status');
  const isLeaderOrStaff =
    leaderPeerId === selfPeerId || selfRoles.includes('staff');

  if (milestone.startTime != null) {
    const seconds = jklmMath.secondsLeft(
      milestone.startTime + serverToLocalNow,
    );
    statusElt.textContent = getText(
      `⏱️ Round will start in {seconds}s!`,
      'roundWillStartIn',
      { seconds },
    );
    setTimeout(renderSeatingStatus, 500);
  } else {
    if (milestone.rulesLocked) {
      const missingPlayers = Math.max(0, constants.minPlayers - players.length);
      statusElt.textContent = getText(
        `⏳ Waiting for {missingPlayers} more players…`,
        'waitingForMorePlayers',
        { missingPlayers },
      );
    } else
      statusElt.textContent = isLeaderOrStaff
        ? getText(
            `📋 Close the rules to start the game…`,
            'closeRulesToStartGame',
          )
        : getText(
            `📋 Party leader is editing the rules…`,
            'partyLeaderIsEditingRules',
          );
  }

  $show(
    '.top .seating .startRoundNow',
    leaderPeerId === selfPeerId && milestone.startTime != null,
  );
}

// Round
const wordInput = $('.selfTurn input');
let focusChatTimeoutId = null;

let animateBackground = null;

let arrowAngle = 0;
let lerpArrowAngle = 0;

let wasSelfTurn = false;
let tickSource = null;

let bombPulseTimer = 0;
let previousAnimateTime = 0;
let dpr = window.devicePixelRatio || 1;
let accumulatedSlowFrames = 0;

let explosionStartTime = 0;
const explosionDuration = 500;

const canvas = $('canvas');
const ctx = canvas.getContext('2d', { alpha: true });

const logo = jklmGfx.load('/games/bombparty/images/logo@2x.png');
const bomb = jklmGfx.load('/games/bombparty/images/bomb.svg');
const spark = jklmGfx.load('/games/bombparty/images/spark.svg');
const arrow = jklmGfx.load('/games/bombparty/images/arrow.png');

const statsTimerTd = $('.rules .stats .timer td');

canvas.addEventListener('click', event => {
  wordInput.focus();
});
window.addEventListener('focus', event => {
  wordInput.focus();
});

wordInput.addEventListener('input', wordInput_onInput);
$('.selfTurn form').addEventListener('submit', selfTurnForm_onSubmit);

socket.on('setStartTime', socket_onSetStartTime);
socket.on('nextTurn', socket_onNextTurn);
socket.on('livesLost', socket_onLivesLost);
socket.on('bonusAlphabetCompleted', socket_onBonusAlphabetCompleted);
socket.on('setPlayerWord', socket_onSetPlayerWord);
socket.on('failWord', socket_onFailWord);
socket.on('correctWord', socket_onCorrectWord);
socket.on('happyBirthday', socket_onHappyBirthday);

function wordInput_onInput(event) {
  const word = wordInput.value.trim();
  socket.emit('setWord', word, false);
}

function selfTurnForm_onSubmit(event) {
  event.preventDefault();
  const word = wordInput.value.trim();
  if (word.length > 0) socket.emit('setWord', word, true);
  wordInput.value = '';
}

function socket_onSetStartTime(startTime, serverNow) {
  serverToLocalNow = Date.now() - serverNow;
  milestone.startTime = startTime;
  seating_render();
}

function socket_onNextTurn(playerPeerId, syllable, promptAge) {
  const wasSelfTurn = milestone.currentPlayerPeerId === selfPeerId;
  if (wasSelfTurn) focusChatTimeoutId = setTimeout(focusChat, 300);

  milestone.currentPlayerPeerId = playerPeerId;
  const playerState = milestone.playerStatesByPeerId[playerPeerId];
  playerState.word = '';
  playerState.wasWordValidated = false;
  milestone.syllable = syllable;
  milestone.promptAge = promptAge;
  wordInput.value = '';
  round_render();
}

function focusChat() {
  clearFocusChatTimeout();
  parentWindow.postMessage({ name: 'focusChat' }, '*');
}

function clearFocusChatTimeout() {
  if (focusChatTimeoutId != null) {
    clearTimeout(focusChatTimeoutId);
    focusChatTimeoutId = null;
  }
}

function socket_onLivesLost(playerPeerId, lives) {
  milestone.playerStatesByPeerId[playerPeerId].lives = lives;

  if (milestone.currentPlayerPeerId === playerPeerId) {
    jklmAudio.play('explosion');
    explosionStartTime = Date.now();
  }
  playersByPeerId[playerPeerId].animation = {
    type: 'loseLife',
    startTime: Date.now(),
    duration: 600,
  };
}

function socket_onBonusAlphabetCompleted(playerPeerId, lives) {
  milestone.playerStatesByPeerId[playerPeerId].lives = lives;

  playersByPeerId[playerPeerId].animation = {
    type: 'woo',
    startTime: Date.now(),
    duration: 600,
  };
}

function socket_onSetPlayerWord(playerPeerId, word) {
  milestone.playerStatesByPeerId[playerPeerId].word = word;
}

function socket_onFailWord(playerPeerId, reason) {
  playersByPeerId[playerPeerId].animation = {
    type: `failWord_${reason}`,
    startTime: Date.now(),
    duration: 600,
  };
  jklmAudio.play(
    reason === 'alreadyUsed' ? 'failWord_alreadyUsed' : 'failWord',
  );
}

function socket_onCorrectWord({ playerPeerId, bonusLetters }) {
  milestone.usedWordCount++;
  $('.rules .stats .usedWords td').textContent = milestone.usedWordCount;

  const playerState = milestone.playerStatesByPeerId[playerPeerId];
  playerState.wasWordValidated = true;
  playerState.bonusLetters = bonusLetters;

  let angle = Math.PI / 16 + (Math.PI / 16) * Math.random();
  if (jklmMath.randomInteger(0, 1) === 0) angle = -angle;
  playersByPeerId[playerPeerId].animation = {
    type: 'correct',
    startTime: Date.now(),
    duration: 500,
    angle,
  };

  jklmAudio.play('correctWord');
}

function socket_onHappyBirthday(playerPeerId) {
  jklmAudio.play('correctWord');

  const birthdayPlayerState = milestone.playerStatesByPeerId[playerPeerId];
  birthdayPlayerState.hasBirthday = true;
  let birthdayTimer = 0;

  const items = [];
  const deadItems = [];

  animateBackground = (elapsedTime, canvasWidth, canvasHeight, scale) => {
    function addItem() {
      const isGift = birthdayTimer < 10000 || Math.random() < 0.5;
      items.push({
        isGift,
        x: -canvasWidth / 2 + Math.random() * canvasWidth,
        y:
          (isGift ? -1 : 1) * (48 + canvasHeight * (0.5 + 0.5 * Math.random())),
        angle: isGift ? Math.random() * Math.PI * 2 : 0,
        scale: (isGift ? 1 : 2) * (1 + Math.random()),
      });
    }

    birthdayTimer += elapsedTime;

    if (items.length < 100 && Math.random() < 0.1) addItem();

    const animProgress = birthdayTimer / 5000;
    const factor = 1.0 - Math.pow(1.0 - animProgress, 2);

    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '48px Vsans-serif';

    for (const item of items) {
      if (!item.dead && item.isGift && item.y > canvasHeight / 2 + 48)
        deadItems.push(item);
      else if (!item.dead && !item.isGift && item.y < -canvasHeight / 2 - 48)
        deadItems.push(item);

      item.y += ((item.isGift ? 1 : -3) * elapsedTime) / 5;
      if (item.isGift) item.angle += elapsedTime / 100;

      ctx.save();
      ctx.translate(item.x, item.y);
      ctx.rotate(item.angle);
      ctx.scale(item.scale, item.scale);
      ctx.fillText(item.isGift ? '🎁' : '🎈', 0, 0);
      ctx.restore();
    }

    for (const deadItem of deadItems) items.splice(items.indexOf(deadItem), 1);
    deadItems.length = 0;
  };
}

function round_enter() {
  jklmAudio.play('start');
  wordInput.value = '';
  if (document.getElementById('hintHolder') !== null)
    socket.emit(
      'hintHolder',
      document.getElementById('hintHolder').textContent,
    );
}

function round_exit() {
  parentWindow.postMessage(
    {
      name: 'appendToChat',
      text: `💣 Round lasted ${statsTimerTd.textContent} and ${milestone.usedWordCount} words were used.`,
    },
    '*',
  );
  focusChat();

  // Clear players when going back to seating
  players.length = 0;
  playersByPeerId = {};
  const canEditRules =
    leaderPeerId === selfPeerId || selfRoles.includes('staff');
  if (canEditRules) socket.emit('setRulesLocked', !showRules);
}

function round_render() {
  milestone.playerStatesByPeerId[milestone.currentPlayerPeerId].syllable =
    milestone.syllable;

  $hide('.top');
  $('.middle .round .syllable').textContent = milestone.syllable;

  const isSelfTurn = milestone.currentPlayerPeerId === selfPeerId;

  $('.bottom .round .otherTurn .player').textContent =
    playersByPeerId[milestone.currentPlayerPeerId].profile.nickname;
  $show('.bottom .round .otherTurn', !isSelfTurn);
  $show('.bottom .round .selfTurn', isSelfTurn);

  if (!wasSelfTurn && isSelfTurn) jklmAudio.play('selfTurn');
  wasSelfTurn = isSelfTurn;

  if (isSelfTurn) {
    if (!isLargeScreen()) showRules = false;
    clearFocusChatTimeout();
    parentWindow.postMessage({ name: 'focusGameWindow' }, '*');
    wordInput.focus();
    if (tickSource == null) tickSource = jklmAudio.play('tick', { loop: true });
  } else {
    if (tickSource != null) {
      tickSource.stop();
      tickSource = null;
    }
  }

  applyRulesVisibility();

  $('.rules .stats .usedWords td').textContent = milestone.usedWordCount;

  const currentPlayerIndex = players.indexOf(
    playersByPeerId[milestone.currentPlayerPeerId],
  );
  arrowAngle = (currentPlayerIndex * Math.PI * 2) / players.length;
}

function animate(animateTime) {
  requestAnimationFrame(animate);

  const elapsedAnimateTime =
    previousAnimateTime > 0 ? animateTime - previousAnimateTime : 0;
  previousAnimateTime = animateTime;

  const canvasRect = canvas.getBoundingClientRect();
  const canvasWidth = canvasRect.width;
  const canvasHeight = canvasRect.height;
  if (dpr > 1 && !document.hidden && elapsedAnimateTime > 1000 / 20) {
    accumulatedSlowFrames++;

    if (accumulatedSlowFrames > 5) {
      console.log(
        'Game is running slowly, downgrading to non-high-density rendering.',
      );
      dpr = 1;
    }
  } else {
    accumulatedSlowFrames = 0;
  }

  canvas.width = Math.round(canvasWidth * dpr);
  canvas.height = Math.round(canvasHeight * dpr);

  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);

  const isLogoVisible =
    milestone.name === 'seating' &&
    milestone.lastRound == null &&
    players.length === 0;

  if (isLogoVisible) {
    ctx.save();
    ctx.translate(canvasWidth / 2, canvasHeight / 2);
    const scale = Math.min(0.5, canvasWidth / logo.width);
    ctx.scale(scale, scale);
    if (logo.complete) jklmGfx.draw(ctx, logo);
    ctx.restore();
  }

  ctx.font = `1em "Lato"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let angle = 0;
  const maxRadius = 250;
  const radius = Math.max(
    50,
    Math.min(maxRadius, canvasWidth / 2 - 60, canvasHeight / 2 - 100),
  );
  const scale = Math.max(0.5, radius / maxRadius);
  const playerScale = 1 + Math.min(scale, 1 / Math.max(1, players.length - 4));
  const avatarSize = 40 * scale;

  ctx.save();
  ctx.translate(canvasWidth / 2, canvasHeight / 2);
  ctx.scale(scale, scale);

  if (milestone.name === 'round') {
    if (animateBackground != null) {
      ctx.save();
      animateBackground(elapsedAnimateTime, canvasWidth, canvasHeight, scale);
      ctx.restore();
    }

    statsTimerTd.textContent = jklmMath.formatSeconds(
      jklmMath.secondsSince(milestone.startTime + serverToLocalNow),
    );

    ctx.save();
    lerpArrowAngle = jklmMath.lerpAngle(lerpArrowAngle, arrowAngle, 0.15);
    ctx.rotate(lerpArrowAngle);
    if (arrow.complete) jklmGfx.draw(ctx, arrow);
    ctx.restore();
  }

  if (!isLogoVisible && milestone.lastRound == null && bomb.complete) {
    if (milestone.name === 'round') {
      // Pulse
      bombPulseTimer++;
      const pulse = (bombPulseTimer % 20) / 20;
      const bombScale = 1.05 - 0.05 * pulse * pulse;
      ctx.scale(bombScale, bombScale);
      jklmGfx.draw(ctx, bomb);

      // Spark
      ctx.save();
      ctx.translate(50, -65);
      ctx.rotate(Math.random() * Math.PI * 2);
      const sparkScale = 0.8 + 0.4 * Math.random();
      ctx.scale(sparkScale, sparkScale);
      if (spark.complete) jklmGfx.draw(ctx, spark);
      ctx.restore();
    } else {
      jklmGfx.draw(ctx, bomb);
    }
  }

  if (explosionStartTime !== 0) {
    const explosionTime = Date.now() - explosionStartTime;
    if (explosionTime > explosionDuration) {
      explosionStartTime = 0;
    } else {
      const progress = explosionTime / explosionDuration;
      const anim = 1 - Math.pow(progress, 5);
      ctx.save();
      ctx.scale(2 + anim * 2, 2 + anim * 2);
      ctx.font = `4em "Lato"`;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.5 * (1 - progress)})`;
      ctx.rotate(Math.random() * Math.PI * 2);
      ctx.fillText('💥', 0, 0);
      ctx.restore();
    }
  }

  ctx.restore();

  // Bonus alphabet
  if (milestone.name === 'round') {
    const selfPlayerState = milestone.playerStatesByPeerId[selfPeerId];
    if (selfPlayerState != null && radius > 50) {
      const horizontal = canvasWidth < 400 + radius * 2;
      const letterSize = horizontal ? 24 : 36;
      const letterSpacing = 8;

      ctx.textAlign = 'center';
      ctx.save();
      if (horizontal)
        ctx.translate(letterSpacing, canvasHeight - letterSize - letterSpacing);
      else
        ctx.translate(canvasWidth - letterSize - letterSpacing, letterSpacing);

      ctx.translate(letterSize / 2, letterSize / 2);
      let offset1 = 0;
      let offset2 = 0;
      const customBonusAlphabet = rules.customBonusAlphabet.value;
      for (const letter in customBonusAlphabet) {
        if (customBonusAlphabet[letter] === 0) continue;
        ctx.save();
        ctx.translate(
          horizontal ? offset1 : offset2,
          horizontal ? offset2 : offset1,
        );
        ctx.fillStyle =
          selfPlayerState.bonusLetters[letter] <= 0 ? '#888' : '#db6';
        ctx.fillRect(-letterSize / 2, -letterSize / 2, letterSize, letterSize);

        ctx.font = `bold 1em "Lato"`;
        ctx.fillStyle = '#444';
        ctx.fillText(letter.toUpperCase(), 0, 0);
        ctx.restore();
        if (
          customBonusAlphabet[letter] > 0 &&
          selfPlayerState.bonusLetters[letter] > 1
        ) {
          ctx.font = "bold 0.7em 'Lato'";
          ctx.fillStyle = '#444';
          ctx.fillText(
            selfPlayerState.bonusLetters[letter],
            horizontal
              ? offset1 - letterSize / 3.5
              : offset2 - letterSize / 3.5,
            horizontal
              ? offset2 + (letterSize * 2) / 6
              : offset1 + (letterSize * 2) / 5.5,
          );
        }

        offset1 += letterSize + letterSpacing;
        if (horizontal) {
          if (offset1 + letterSize + letterSpacing * 2 > canvasWidth) {
            offset1 = 0;
            offset2 -= letterSize + letterSpacing;
          }
        } else {
          if (offset1 + letterSize + letterSpacing * 2 > canvasHeight) {
            offset1 = 0;
            offset2 -= letterSize + letterSpacing;
          }
        }
      }

      ctx.restore();
    }
  }

  // Players
  const skipDrawingOtherPlayers = radius <= 50;

  function setupCtxforPlayer(i) {
    angle = (i / players.length) * Math.PI * 2;

    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    ctx.save();
    ctx.translate(canvasWidth / 2 + x, canvasHeight / 2 + y);
    ctx.scale(playerScale, playerScale);
  }

  function drawPlayerAvatars() {
    ctx.fillStyle = '#888';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 2;
    ctx.font = `1.25em "Lato"`;

    for (let i = 0; i < players.length; i++) {
      const player = players[i];

      setupCtxforPlayer(i);

      ctx.save();

      const { animation } = playersByPeerId[player.profile.peerId];
      let animProgress = 0;
      if (animation != null) {
        animProgress = (Date.now() - animation.startTime) / animation.duration;
        if (animProgress < 1) {
          switch (animation.type) {
            case 'join': {
              const smoothDecay = Math.pow(1.0 - animProgress, 3);
              const scale = 1 - 0.5 * smoothDecay;
              ctx.scale(scale, scale);
              ctx.rotate((Math.PI / 4) * smoothDecay);
              break;
            }

            case 'failWord_mustContainSyllable':
            case 'failWord_notInDictionary':
            case 'failWord_alreadyUsed': {
              const x = 10 * (1.0 - animProgress);
              ctx.translate(Math.cos(animProgress * 20) * x, 0);
              break;
            }

            case 'correct': {
              const smoothDecay = Math.pow(1.0 - animProgress, 3);
              const scale = 1 + 0.3 * smoothDecay;
              ctx.scale(scale, scale);
              ctx.rotate(animation.angle * smoothDecay);
              break;
            }

            case 'woo': {
              const smoothDecay = Math.pow(1.0 - animProgress, 3);
              const scale = 1 + 0.3 * smoothDecay;
              ctx.scale(1, scale);

              ctx.rotate(Math.PI * 2 * (1.0 - smoothDecay));
              break;
            }

            case 'loseLife': {
              const scale = 1 - 0.2 * Math.pow(1.0 - animProgress, 3);
              ctx.scale(1, scale);

              const x = 10 * (1.0 - animProgress);
              const y = 10 * Math.pow(1.0 - animProgress, 2);
              ctx.translate(Math.cos(animProgress * 20) * x, y);
              break;
            }
          }
        } else playersByPeerId[player.profile.peerId].animation = null;
      }

      if (
        player.image.src.length &&
        player.image.complete &&
        player.image.naturalHeight !== 0
      ) {
        ctx.drawImage(
          player.image,
          -avatarSize / 2,
          -avatarSize / 2,
          avatarSize,
          avatarSize,
        );
      } else {
        ctx.fillRect(-avatarSize / 2, -avatarSize / 2, avatarSize, avatarSize);
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.scale(scale, scale);
        ctx.fillText('👤', 0, 0);
        ctx.restore();
      }

      ctx.restore();

      if (animation != null) {
        const factor = 1.0 - Math.pow(1.0 - animProgress, 2);

        switch (animation.type) {
          case 'loseLife':
            const playerState =
              milestone.playerStatesByPeerId[player.profile.peerId];
            ctx.fillStyle =
              playerState.lives > 0
                ? `rgba(255, ${Math.floor(255 * (1 - factor))}, 0, ${
                    0.5 - factor * 0.5
                  })`
                : `rgba(0, 0, 0, ${0.5 - factor * 0.5})`;
            ctx.scale(1 + factor, 1 + factor);
            ctx.beginPath();
            ctx.arc(0, 0, avatarSize, 0, Math.PI * 2);
            ctx.fill();
            if (playerState.lives === 0) {
              ctx.scale(3, 3);
              ctx.fillText('☠', 0, 0);
            } else {
              ctx.fillText('💔', 0, -avatarSize * (0.5 + factor / 2));
            }
            break;

          case 'correct':
            ctx.fillStyle = `rgba(64, ${64 + Math.floor(192 * factor)}, 64, ${
              0.5 - factor * 0.5
            })`;
            ctx.scale(1 + factor, 1 + factor);
            ctx.beginPath();
            ctx.arc(0, 0, avatarSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillText('✔️', 0, -avatarSize * (0.5 + factor / 2));
            break;

          case 'failWord_mustContainSyllable':
          case 'failWord_notInDictionary':
          case 'failWord_alreadyUsed':
            ctx.fillStyle = `rgba(255, 255, 255, ${0.5 - factor * 0.5})`;
            ctx.scale(1 + factor, 1 + factor);
            ctx.fillText(
              animation.type === 'failWord_alreadyUsed' ? '🔒' : '❌',
              0,
              -avatarSize * (0.5 + factor / 2),
            );
            break;

          case 'woo':
            ctx.fillStyle = `rgba(255, 255, 255, ${0.5 - factor * 0.5})`;
            ctx.scale(1 + factor, 1 + factor);
            ctx.beginPath();
            ctx.arc(0, 0, avatarSize, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillText('💖', 0, -avatarSize * (0.5 + factor / 2));
            break;
        }
      }

      ctx.restore();
    }
  }

  function drawPlayerHearts() {
    if (milestone.name !== 'round') return;

    ctx.font = `${0.7 / scale}em "Lato"`;

    for (let i = 0; i < players.length; i++) {
      const player = players[i];

      setupCtxforPlayer(i);
      ctx.scale(scale, scale);
      const playerState = milestone.playerStatesByPeerId[player.profile.peerId];
      ctx.fillStyle = '#FF0000';
      const hearts =
        playerState.lives > 0
          ? (playerState.hasBirthday ? '🍰' : '❤️').repeat(playerState.lives)
          : '☠️';
      ctx.fillText(hearts, 0, -20);
      ctx.restore();
    }
  }

  function drawPlayerNames() {
    ctx.globalAlpha = 1.0;
    ctx.shadowColor = 'black';
    ctx.shadowBlur = 4;
    ctx.textAlign = 'center';

    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (skipDrawingOtherPlayers && player.profile.peerId !== selfPeerId)
        continue;

      setupCtxforPlayer(i);

      ctx.font = `${player.isOnline ? '' : 'italic '}0.75em "Lato"`;
      ctx.fillStyle = player.isOnline ? '#fff' : '#888';

      let nickname = player.profile.nickname;
      if (
        nickname.length > 1 &&
        ctx.measureText(nickname).width > 100 * scale
      ) {
        const nicknameCodepoints = Array.from(nickname);
        while (
          nicknameCodepoints.length > 1 &&
          ctx.measureText(nicknameCodepoints.join('')).width > 100 * scale
        )
          nicknameCodepoints.splice(nicknameCodepoints.length - 1);
        nickname = nicknameCodepoints.join('') + '…';
      }

      if (
        milestone.name === 'round' &&
        milestone.playerStatesByPeerId[player.profile.peerId].hasBirthday
      ) {
        nickname = `🥳 ${nickname}`;
      }

      ctx.fillText(nickname, 0, -avatarSize / 2 - 15);

      ctx.restore();
    }

    ctx.shadowColor = 'transparent';
  }

  function drawPlayerWords() {
    if (milestone.name !== 'round') return;

    ctx.shadowColor = 'black';
    ctx.shadowBlur = 2;
    ctx.textAlign = 'left';

    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      const isCurrentPlayer =
        player.profile.peerId === milestone.currentPlayerPeerId;
      if (skipDrawingOtherPlayers && !isCurrentPlayer) continue;

      setupCtxforPlayer(i);

      ctx.font = (isCurrentPlayer ? 'bold ' : '') + `0.75em "Lato"`;
      const wordFillStyle = isCurrentPlayer ? '#fff' : '#aaa';
      ctx.fillStyle = wordFillStyle;

      const { word, syllable, wasWordValidated } =
        milestone.playerStatesByPeerId[player.profile.peerId];

      const syllableIndex = syllable != null ? word.indexOf(syllable) : -1;
      const wordWidth = ctx.measureText(word.toUpperCase()).width;
      let wordX = -wordWidth / 2;

      const wordY = 0 + avatarSize / 2 + 15;

      if (syllableIndex !== -1) {
        const before = word.substring(0, syllableIndex);
        const after = word.substring(syllableIndex + syllable.length);

        ctx.fillText(before.toUpperCase(), wordX, wordY);

        wordX += ctx.measureText(before.toUpperCase()).width;
        ctx.fillStyle = '#4d4';
        ctx.fillText(syllable.toUpperCase(), wordX, wordY);

        wordX += ctx.measureText(syllable.toUpperCase()).width;
        ctx.fillStyle = wordFillStyle;
        ctx.fillText(after.toUpperCase(), wordX, wordY);
      } else {
        ctx.fillText(word.toUpperCase(), wordX, wordY);
      }

      if (!isCurrentPlayer && !wasWordValidated)
        ctx.fillRect(-wordWidth / 2, wordY - 1, wordWidth, 2);

      ctx.restore();
    }
  }

  drawPlayerAvatars();
  drawPlayerHearts();
  drawPlayerNames();
  drawPlayerWords();
}
