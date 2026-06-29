// Constants & State
const ACCOUNTS_KEY = 'google_accounts';
const ENCRYPTED_KEY = 'google_accounts_encrypted';
let accounts = [];
let masterPwd = null;

// DOM Elements
const addAccountForm = document.getElementById('addAccountForm');
const accountsList = document.getElementById('accountsList');
const accountCount = document.getElementById('accountCount');
const toast = document.getElementById('toast');
const searchInput = document.getElementById('searchInput');

// Lock Screen Elements
const lockScreen = document.getElementById('lockScreen');
const unlockForm = document.getElementById('unlockForm');
const masterPasswordInput = document.getElementById('masterPasswordInput');

// Security Modal Elements
const securityBtn = document.getElementById('securityBtn');
const securityModal = document.getElementById('securityModal');
const setMasterPwdBtn = document.getElementById('setMasterPwdBtn');
const newMasterPwdInput = document.getElementById('newMasterPwd');
const removeMasterPwdBtn = document.getElementById('removeMasterPwdBtn');
const setupPasswordSection = document.getElementById('setupPasswordSection');
const removePasswordSection = document.getElementById('removePasswordSection');

// Export & Import Elements
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const clearAllBtn = document.getElementById('clearAllBtn');
const importModal = document.getElementById('importModal');
const confirmImportBtn = document.getElementById('confirmImportBtn');
const importText = document.getElementById('importText');
const convertFormatBtn = document.getElementById('convertFormatBtn');

// Edit Elements
const editModal = document.getElementById('editModal');
const editAccountForm = document.getElementById('editAccountForm');

// Change 2FA Elements
const change2FAModal = document.getElementById('change2FAModal');
const change2FAForm = document.getElementById('change2FAForm');
const qrInput = document.getElementById('qrInput');
const qrResultText = document.getElementById('qrResultText');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkEncryptionState();
});

// --- Security & Encryption ---

function checkEncryptionState() {
    const hasEncrypted = localStorage.getItem(ENCRYPTED_KEY);
    const hasPlaintext = localStorage.getItem(ACCOUNTS_KEY);

    if (hasEncrypted) {
        lockScreen.classList.add('show');
        setupPasswordSection.style.display = 'none';
        removePasswordSection.style.display = 'block';
    } else {
        lockScreen.classList.remove('show');
        setupPasswordSection.style.display = 'block';
        removePasswordSection.style.display = 'none';
        if (hasPlaintext) {
            accounts = JSON.parse(hasPlaintext);
        }
        finishInit();
    }
}

unlockForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const pwd = masterPasswordInput.value;
    const encryptedData = localStorage.getItem(ENCRYPTED_KEY);
    
    try {
        const bytes = CryptoJS.AES.decrypt(encryptedData, pwd);
        const decryptedStr = bytes.toString(CryptoJS.enc.Utf8);
        
        if (!decryptedStr) throw new Error("Wrong password");
        
        accounts = JSON.parse(decryptedStr);
        masterPwd = pwd;
        lockScreen.classList.remove('show');
        masterPasswordInput.value = '';
        showToast('解锁成功');
        finishInit();
    } catch (err) {
        showToast('密码错误！', 'error');
        masterPasswordInput.value = '';
    }
});

setMasterPwdBtn.addEventListener('click', () => {
    const newPwd = newMasterPwdInput.value.trim();
    if (!newPwd) return showToast('密码不能为空', 'error');
    
    masterPwd = newPwd;
    saveAccounts();
    localStorage.removeItem(ACCOUNTS_KEY);
    
    newMasterPwdInput.value = '';
    securityModal.classList.remove('show');
    setupPasswordSection.style.display = 'none';
    removePasswordSection.style.display = 'block';
    showToast('已设置主密码！数据现已加密。');
});

removeMasterPwdBtn.addEventListener('click', () => {
    if (confirm('确定要取消主密码吗？您的账号数据将以明文保存在浏览器中。')) {
        masterPwd = null;
        saveAccounts();
        localStorage.removeItem(ENCRYPTED_KEY);
        
        securityModal.classList.remove('show');
        setupPasswordSection.style.display = 'block';
        removePasswordSection.style.display = 'none';
        showToast('主密码已移除，数据已解密。');
    }
});

// Save to LocalStorage
function saveAccounts() {
    const dataStr = JSON.stringify(accounts);
    if (masterPwd) {
        const encrypted = CryptoJS.AES.encrypt(dataStr, masterPwd).toString();
        localStorage.setItem(ENCRYPTED_KEY, encrypted);
        localStorage.removeItem(ACCOUNTS_KEY);
    } else {
        localStorage.setItem(ACCOUNTS_KEY, dataStr);
        localStorage.removeItem(ENCRYPTED_KEY);
    }
    renderAccounts(searchInput.value);
}

function finishInit() {
    renderAccounts();
    startTOTPUpdates();
}

// --- UI Utilities ---

function showToast(message, type = 'success') {
    toast.textContent = message;
    const colors = { success: 'var(--success)', error: 'var(--danger)', warning: '#f59e0b' };
    toast.style.backgroundColor = colors[type] || colors.success;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

async function copyToClipboard(text, elementId = null) {
    try {
        // 1. 尝试现代异步 Clipboard API (只在 https 或 localhost 下有效)
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            triggerSuccessIndicator(elementId);
            return;
        }
    } catch (err) {
        console.warn("Async clipboard API failed, trying fallback...", err);
    }

    // 2. 尝试高级 iOS/Android 兼容性 document.execCommand 动态 TextArea 方案
    let copyStatus = false;
    try {
        const tempTextArea = document.createElement("textarea");
        tempTextArea.value = text;
        
        // 关键：必须在屏幕可视区域内，但透明度极低，防止闪烁
        tempTextArea.style.fontSize = '12pt';
        tempTextArea.style.border = '0';
        tempTextArea.style.padding = '0';
        tempTextArea.style.margin = '0';
        tempTextArea.style.position = 'fixed';
        tempTextArea.style.left = '0';
        tempTextArea.style.top = '0';
        tempTextArea.style.opacity = '0.01';
        tempTextArea.style.width = '100px';
        tempTextArea.style.height = '100px';
        
        tempTextArea.removeAttribute('readonly');
        tempTextArea.contentEditable = true;
        
        document.body.appendChild(tempTextArea);
        tempTextArea.focus();
        
        if (navigator.userAgent.match(/ipad|iphone/i)) {
            tempTextArea.setSelectionRange(0, text.length);
        } else {
            tempTextArea.select();
        }
        
        copyStatus = document.execCommand('copy');
        document.body.removeChild(tempTextArea);
    } catch (err) {
        console.error("iOS copy hack failed: ", err);
    }

    if (copyStatus) {
        triggerSuccessIndicator(elementId);
    } else {
        // 3. 终极兜底：唤起“手动复制助手”弹窗
        openCopyAssistant(text);
    }
}

// 辅助函数：触发复制成功视觉反馈
function triggerSuccessIndicator(elementId) {
    showToast('复制成功！');
    if (elementId) {
        const icon = document.getElementById(elementId);
        if (icon) {
            const originalClass = icon.className;
            icon.className = 'fa-solid fa-check text-success';
            setTimeout(() => icon.className = originalClass, 2000);
        }
    }
}

// 唤起复制助手 modal 弹窗
function openCopyAssistant(text) {
    const modal = document.getElementById('copyAssistantModal');
    const assistantText = document.getElementById('copyAssistantText');
    
    if (modal && assistantText) {
        assistantText.innerText = text;
        modal.classList.add('show');
        
        // 自动触发全选高亮
        setTimeout(() => {
            selectAssistantText();
        }, 250);
    }
}

// 复制助手的全选文本逻辑 (基于 Range 和 Selection API，键盘不弹起，菜单必出现)
window.selectAssistantText = function() {
    const assistantText = document.getElementById('copyAssistantText');
    if (assistantText) {
        try {
            const range = document.createRange();
            range.selectNodeContents(assistantText);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (err) {
            console.error("Assistant selection error: ", err);
        }
    }
}

// --- Account Management ---

function cleanSecretInput(secret) {
    if (!secret) return '';
    return secret.trim().replace(/[\s\-]/g, '').toUpperCase();
}

function escapeForAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isValidBase32(secret) {
    // 允许 A-Z 和 0-9，只要是长度大于等于 4 的字母数字组合，都允许保存（对包含人为 typo 如 0,1,8,9 的秘钥不再强行拦截）
    return /^[A-Z0-9]+=*$/i.test(secret) && secret.length >= 4;
}

addAccountForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value.trim();
    const recovery = document.getElementById('recovery').value.trim();
    let secret = cleanSecretInput(document.getElementById('secret').value);
    const note = document.getElementById('note').value.trim();

    if (accounts.some(a => a.email.toLowerCase() === email.toLowerCase())) {
        return showToast('该邮箱已存在！', 'error');
    }

    // 2FA is optional - only validate if provided
    if (secret && secret.length > 0 && !isValidBase32(secret)) {
        showToast('提示：2FA 秘钥格式可能不正确', 'error');
    }

    accounts.push({
        id: Date.now().toString(),
        email, password, recovery, secret, note
    });
    
    saveAccounts();
    addAccountForm.reset();
    showToast('账号添加成功');
});

window.deleteAccount = function(id) {
    if (confirm('确定要删除这个账号吗？不可恢复！')) {
        accounts = accounts.filter(acc => acc.id !== id);
        saveAccounts();
        showToast('账号已删除');
    }
}

window.openEditModal = function(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    
    document.getElementById('edit-id').value = acc.id;
    document.getElementById('edit-email').value = acc.email;
    document.getElementById('edit-password').value = acc.password;
    document.getElementById('edit-recovery').value = acc.recovery || '';
    document.getElementById('edit-secret').value = acc.secret;
    document.getElementById('edit-note').value = acc.note || '';
    
    editModal.classList.add('show');
};

editAccountForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('edit-id').value;
    const index = accounts.findIndex(a => a.id === id);
    if (index !== -1) {
        const email = document.getElementById('edit-email').value.trim();
        const secret = cleanSecretInput(document.getElementById('edit-secret').value);
        
        // Check duplicate email
        if (accounts.some((a, i) => i !== index && a.email.toLowerCase() === email.toLowerCase())) {
            return showToast('该邮箱已存在！', 'error');
        }
        
        if (secret && secret.length > 0 && !isValidBase32(secret)) {
            showToast('提示：2FA 秘钥格式可能不正确', 'error');
        }

        accounts[index] = {
            id,
            email,
            password: document.getElementById('edit-password').value.trim(),
            recovery: document.getElementById('edit-recovery').value.trim(),
            secret,
            note: document.getElementById('edit-note').value.trim()
        };
        saveAccounts();
        editModal.classList.remove('show');
        showToast('账号信息已更新');
    }
});

// Change 2FA specifically
window.openChange2FAModal = function(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    document.getElementById('change-2fa-id').value = acc.id;
    document.getElementById('new-2fa-secret').value = '';
    qrResultText.style.display = 'none';
    qrInput.value = ''; // reset file input
    change2FAModal.classList.add('show');
};

change2FAForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('change-2fa-id').value;
    let secret = cleanSecretInput(document.getElementById('new-2fa-secret').value);
    
    if (!secret || secret.length < 1) {
        return showToast('请输入秘钥！', 'error');
    }

    const index = accounts.findIndex(a => a.id === id);
    if (index !== -1) {
        accounts[index].secret = secret;
        saveAccounts();
        change2FAModal.classList.remove('show');
        showToast('2FA 秘钥更换成功！已开始生成新验证码。');
    }
});

// QR Code Scanner Logic
qrInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            if (code) {
                try {
                    // Expecting otpauth://totp/...secret=XXX
                    const url = new URL(code.data);
                    const secret = url.searchParams.get('secret');
                    if (secret) {
                        document.getElementById('new-2fa-secret').value = cleanSecretInput(secret);
                        qrResultText.style.display = 'block';
                        showToast('成功解析二维码中的秘钥！');
                    } else {
                        throw new Error("No secret param");
                    }
                } catch(err) {
                    showToast('二维码中未包含有效的 2FA 秘钥', 'error');
                }
            } else {
                showToast('无法识别二维码内容，请尝试更高清的截图', 'error');
            }
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
});


// Clear All Accounts
if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
        if (accounts.length === 0) return showToast('没有账号可以删除。', 'error');
        if (confirm('⚠️ 警告：您确定要删除【所有】账号吗？此操作无法撤销！')) {
            accounts = [];
            saveAccounts();
            showToast('所有账号已清空', 'success');
        }
    });
}

// Toggle Password
window.togglePassword = function(id, password) {
    const pwdSpan = document.getElementById(`pwd-text-${id}`);
    const eyeIcon = document.getElementById(`icon-eye-${id}`);
    
    if (pwdSpan.dataset.hidden === 'true') {
        pwdSpan.textContent = password;
        pwdSpan.dataset.hidden = 'false';
        eyeIcon.classList.remove('fa-eye');
        eyeIcon.classList.add('fa-eye-slash');
    } else {
        pwdSpan.textContent = '••••••••';
        pwdSpan.dataset.hidden = 'true';
        eyeIcon.classList.remove('fa-eye-slash');
        eyeIcon.classList.add('fa-eye');
    }
};

// Generate TOTP Code
function getTOTP(secret) {
    try {
        let cleanSecret = cleanSecretInput(secret);
        if (!isValidBase32(cleanSecret)) return "格式错";
        let totp = new OTPAuth.TOTP({
            issuer: 'Google',
            label: 'Account',
            algorithm: 'SHA1',
            digits: 6,
            period: 30,
            secret: OTPAuth.Secret.fromBase32(cleanSecret)
        });
        return totp.generate();
    } catch (e) {
        return "格式错";
    }
}

window.copyFullAccount = function(id) {
    const acc = accounts.find(a => a.id === id);
    if (!acc) return;
    const str = `${acc.email}---${acc.password}---${acc.recovery || ''}---${acc.secret}---${acc.note || ''}`;
    copyToClipboard(str);
};

// --- Render & Search ---

searchInput.addEventListener('input', (e) => {
    renderAccounts(e.target.value);
});

function renderAccounts(filterText = '') {
    const lowerFilter = filterText.toLowerCase();
    const filteredAccounts = accounts.filter(acc => {
        return acc.email.toLowerCase().includes(lowerFilter) ||
               (acc.recovery && acc.recovery.toLowerCase().includes(lowerFilter)) ||
               (acc.note && acc.note.toLowerCase().includes(lowerFilter));
    });

    accountCount.textContent = filteredAccounts.length;
    accountsList.innerHTML = '';

    filteredAccounts.forEach(acc => {
        const currentCode = getTOTP(acc.secret);
        const card = document.createElement('div');
        card.className = 'account-card';
        card.innerHTML = `
            <div class="account-header">
                <div>
                    <div class="account-email" title="${acc.email}">${acc.email}</div>
                    ${acc.note ? `<div class="account-note">${acc.note}</div>` : ''}
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn-icon" onclick="copyFullAccount('${acc.id}')" title="复制完整账号串">
                        <i class="fa-solid fa-clipboard-list"></i>
                    </button>
                    <button class="btn-icon" onclick="openEditModal('${acc.id}')" title="编辑基本信息">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-icon btn-danger" onclick="deleteAccount('${acc.id}')" title="删除">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
            
            <div class="account-details">
                <div class="detail-row">
                    <span><strong>密码:</strong> <span id="pwd-text-${acc.id}" data-hidden="true">••••••••</span></span>
                    <div class="actions">
                        <i class="fa-regular fa-eye" id="icon-eye-${acc.id}" onclick="togglePassword('${acc.id}', '${escapeForAttr(acc.password)}')" title="显示/隐藏密码"></i>
                        <i class="fa-regular fa-copy" id="icon-pwd-${acc.id}" onclick="copyToClipboard('${escapeForAttr(acc.password)}', 'icon-pwd-${acc.id}')" title="复制密码"></i>
                    </div>
                </div>
                ${acc.recovery ? `
                <div class="detail-row" onclick="copyToClipboard('${escapeForAttr(acc.recovery)}', 'icon-rec-${acc.id}')">
                    <span><strong>辅助邮箱:</strong> ${acc.recovery}</span>
                    <i class="fa-regular fa-copy" id="icon-rec-${acc.id}"></i>
                </div>
                ` : ''}
            </div>

            <div class="code-display" onclick="copyToClipboard(document.getElementById('code-${acc.id}').innerText)">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 0.8rem; color: var(--text-secondary); opacity: 0;">占位</span>
                    <div class="totp-code" id="code-${acc.id}">${currentCode}</div>
                    <button class="btn-icon" style="color: var(--accent-color); z-index: 10;" onclick="event.stopPropagation(); openChange2FAModal('${acc.id}')" title="更换 2FA">
                        <i class="fa-solid fa-arrows-rotate"></i> 换新
                    </button>
                </div>
                <div class="totp-timer" id="timer-${acc.id}"></div>
            </div>
        `;
        accountsList.appendChild(card);
    });
}

function startTOTPUpdates() {
    let prevRemaining = -1;
    setInterval(() => {
        const epoch = Math.floor(Date.now() / 1000);
        const remainingSeconds = 30 - (epoch % 30);
        const percentage = (remainingSeconds / 30) * 100;

        // Detect new period (remaining jumped back up)
        const newPeriod = remainingSeconds > prevRemaining;
        prevRemaining = remainingSeconds;

        accounts.forEach(acc => {
            const codeEl = document.getElementById(`code-${acc.id}`);
            const timerEl = document.getElementById(`timer-${acc.id}`);
            
            if (codeEl && timerEl) {
                if (newPeriod) {
                    codeEl.innerText = getTOTP(acc.secret);
                }
                timerEl.style.width = `${percentage}%`;
                if (remainingSeconds < 5) {
                    timerEl.style.backgroundColor = 'var(--danger)';
                    codeEl.style.color = 'var(--danger)';
                } else {
                    timerEl.style.backgroundColor = 'var(--success)';
                    codeEl.style.color = 'var(--success)';
                }
            }
        });
    }, 1000);
}

// --- Modals & Export/Import ---

securityBtn.addEventListener('click', () => securityModal.classList.add('show'));
importBtn.addEventListener('click', () => importModal.classList.add('show'));

// Export
exportBtn.addEventListener('click', () => {
    if (accounts.length === 0) return showToast('没有账号可以导出', 'error');
    
    let content = '';
    accounts.forEach(acc => {
        content += `${acc.email}---${acc.password}---${acc.recovery || ''}---${acc.secret}---${acc.note || ''}\n`;
    });
    
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `google_accounts_backup_${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('备份已导出成功！');
});

// Convert Format
if (convertFormatBtn) {
    convertFormatBtn.addEventListener('click', () => {
        let text = importText.value;
        if (!text) return showToast('请先粘贴账号内容', 'error');
        text = text.replace(/\|/g, '---');
        importText.value = text;
        showToast('格式转换成功！(已将 | 替换为 ---)');
    });
}

// Import
confirmImportBtn.addEventListener('click', () => {
    const text = importText.value.trim();
    if (!text) return;

    // Support both Windows (\r\n) and Unix (\n) line breaks
    const lines = text.split(/\r?\n/);
    let addedCount = 0, failedCount = 0, invalidCount = 0;

    lines.forEach(line => {
        const trimmedLine = line.trim();
        if (!trimmedLine) return;

        // 自动识别分隔符：优先使用 ---，其次使用 |，也可以支持 Tab 制表符
        let parts = [];
        if (trimmedLine.includes('---')) {
            parts = trimmedLine.split('---');
        } else if (trimmedLine.includes('|')) {
            parts = trimmedLine.split('|');
        } else if (trimmedLine.includes('\t')) {
            parts = trimmedLine.split('\t');
        } else {
            parts = trimmedLine.split(/\s+/);
        }

        parts = parts.map(p => p.trim());

        if (parts.length >= 2) {
            const email = parts[0];
            const password = parts[1];
            const recovery = parts.length > 2 ? parts[2] : '';
            const secret = parts.length > 3 ? cleanSecretInput(parts[3]) : '';
            const note = parts.length > 4 ? parts[4] : '';

            if (!email) {
                invalidCount++;
                return;
            }

            const exists = accounts.some(acc => acc.email.toLowerCase() === email.toLowerCase());
            if (!exists) {
                accounts.push({
                    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                    email: email,
                    password: password,
                    recovery: recovery,
                    secret: secret,
                    note: note
                });
                addedCount++;
            } else {
                failedCount++;
            }
        } else {
            invalidCount++;
        }
    });

    if (addedCount > 0) {
        saveAccounts();
        importText.value = '';
        importModal.classList.remove('show');
        showToast(`成功导入 ${addedCount} 个账号。(重复跳过: ${failedCount}, 格式错误: ${invalidCount})`);
    } else {
        showToast(`未找到有效账号。(重复: ${failedCount}, 格式错误: ${invalidCount})`, 'error');
    }
});
