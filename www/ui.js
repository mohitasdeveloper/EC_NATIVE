export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const typeClasses = {
        info: 'bg-blue-500',
        success: 'bg-primary',
        error: 'bg-error',
        warning: 'bg-orange-500'
    };

    const toast = document.createElement('div');
    toast.className = `w-full ${typeClasses[type]} text-white text-sm font-bold px-4 py-3 rounded-xl shadow-lg transform transition-all duration-300 translate-y-[-20px] opacity-0`;
    toast.textContent = message;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.remove('translate-y-[-20px]', 'opacity-0');
    });

    // Animate out and remove
    setTimeout(() => {
        toast.classList.add('opacity-0', 'scale-90');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 3000);
}
// Small compact menu-item button for the anchored popup menu
// (window.openPopupMenu/closePopupMenu, defined inline in index.html).
// Shared by Messages (chat-row menu, message-bubble menu) and the
// feed's post "more options" menu so every popup menu in the app
// looks and behaves the same way — one source of truth, not a
// copy-pasted button style per feature.
export function popupMenuItem(icon, label, onclick, danger = false) {
    return `<button onclick="${onclick}" class="w-full flex items-center gap-3 px-4 py-2.5 text-[13.5px] font-semibold ${danger ? 'text-error' : 'text-on-surface dark:text-gray-100'} hover:bg-surface-variant/30 dark:hover:bg-white/5 active:bg-surface-variant/40 transition-colors text-left">
        <span class="material-symbols-outlined text-[18px]">${icon}</span>${label}
    </button>`;
}
