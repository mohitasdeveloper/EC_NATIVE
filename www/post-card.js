// ============================================================
// Shared post-card renderer.
//
// This used to be two separate, hand-copied templates:
//   - feed.js's renderPosts() (the main feed)
//   - main.js's generatePostHTML() (the single-post / notification-link view)
// They'd drifted apart in three real ways by the time this file was written:
//   1. main.js's comment filter excluded commentless rows (`&& c.content`),
//      feed.js's didn't.
//   2. main.js's avatar had a stray onclick="window.openPublicProfile(...)" —
//      that function doesn't exist anywhere in the app, so it just threw a
//      console error on every avatar tap in the single-post view (harmless
//      only because the delegated .profile-link handler still fired too).
//   3. main.js's author-name <h4> had ONLY that broken onclick — no
//      .profile-link class, no data-user-id — so tapping the author's NAME
//      (as opposed to their avatar) in the single-post view did nothing at
//      all except throw that same console error.
// Fixed here by standardizing on the working .profile-link + data-user-id
// pattern (delegated in both feed.js and main.js's document-level click
// listeners) everywhere, and keeping the more defensive comment filter.
//
// A third, smaller copy of just the *poll* rendering logic also existed in
// feed.js's window.updatePollUI (the in-place refresh after voting, without
// re-rendering the whole card). That's unified here too, as renderPollBodyHtml.
// ============================================================

import { timeAgo } from './utils.js';

// Fixed identity shown for post_type 'anonymous' — the real author (user_id)
// is still stored on the row for the author's own edit/delete/moderation,
// it's just never rendered anywhere in this card.
const ANONYMOUS_NAME = 'Anonymous';
const ANONYMOUS_AVATAR = 'https://t4.ftcdn.net/jpg/05/89/93/27/360_F_589932782_vQAEAZhHnq1QCGu5ikwrYaQD0Mmurm0N.jpg';

export function getPollTimeLeft(dateStr) {
    if (!dateStr) return '';
    const diff = new Date(dateStr) - new Date();
    if (diff <= 0) return 'Ended';
    const h = Math.floor(diff / (1000 * 60 * 60));
    if (h >= 24) return `${Math.floor(h / 24)}d`;
    if (h > 0) return `${h}h`;
    return `${Math.floor(diff / (1000 * 60))}m`;
}

// Renders just the *inside* of a poll's `.poll-container-wrapper` (quiz badge,
// restriction banner, options, explanation, vote totals, meta labels) — shared
// by the full post-card renderer below AND window.updatePollUI's in-place
// refresh in feed.js, so a poll always looks and behaves the same everywhere
// regardless of which of those two call paths rendered it.
//
// `postMeta` needs `expires_at` and `user_id` — the full `post` row satisfies
// this directly (both call sites already have exactly that).
export function renderPollBodyHtml(postId, poll, votes, postMeta, currentUserId) {
    const isAuthor = currentUserId === postMeta.user_id;
    const totalVotes = votes.length;
    const myVotes = votes.filter(v => v.user_id === currentUserId).map(v => v.option_id);
    const userHasVoted = myVotes.length > 0;

    let isExpired = poll.is_ended_early;
    if (!isExpired && poll.deadline_type === 'time' && poll.deadline_time) {
        isExpired = new Date(poll.deadline_time) < new Date();
    } else if (!isExpired && poll.deadline_type === 'voter_count' && poll.deadline_count) {
        isExpired = totalVotes >= poll.deadline_count;
    } else if (!isExpired && poll.deadline_type === 'time' && postMeta.expires_at) {
        isExpired = new Date(postMeta.expires_at) < new Date();
    }

    // Separated Results (Percentages) from Quiz Answers (Green/Red Highlights)
    const showResults = userHasVoted || isExpired || isAuthor;
    const showQuizAnswers = userHasVoted || isExpired; // Hide answers from author until they vote or it ends

    const isQuiz = poll.is_quiz;
    const correctOptId = poll.correct_option_id;

    let canVote = true;
    let restrictionReason = '';
    if (!isExpired && !isAuthor) {
        if (poll.voters_access === 'selected') {
            if (!poll.allowed_voter_ids || !poll.allowed_voter_ids.includes(currentUserId)) {
                canVote = false;
                restrictionReason = '🔒 Voting restricted to Custom List';
            }
        }
    }
    if (isExpired) {
        canVote = false;
        restrictionReason = '🔒 Poll has ended';
    }

    const optionsHtml = (poll.options || []).map((opt) => {
        const optVotes = votes.filter(v => v.option_id === opt.id).length;
        const percentage = totalVotes === 0 ? 0 : Math.round((optVotes / totalVotes) * 100);
        const iVotedForThis = myVotes.includes(opt.id);

        let optBorderClass = 'border-surface-variant/50 dark:border-neutral-700';
        let optBgClass = 'bg-surface-variant/30 dark:bg-surface-variant/10';
        let checkIconHtml = '';

        // Only show green/red highlights if showQuizAnswers is true
        if (isQuiz && showQuizAnswers) {
            if (opt.id === correctOptId) {
                optBorderClass = 'border-green-500';
                optBgClass = 'bg-green-500/10';
                checkIconHtml = `<span class="material-symbols-outlined text-green-500 text-[18px]">check_circle</span>`;
            } else if (iVotedForThis) {
                optBorderClass = 'border-red-500';
                optBgClass = 'bg-red-500/10';
                checkIconHtml = `<span class="material-symbols-outlined text-red-500 text-[18px]">cancel</span>`;
            }
        } else if (iVotedForThis) {
            optBorderClass = 'border-primary';
        }

        let selectorHtml = '';
        if (!isQuiz || !showQuizAnswers) {
            if (poll.is_multiple_choice) {
                selectorHtml = `<div class="w-4 h-4 rounded-sm border-2 ${iVotedForThis ? 'border-primary bg-primary flex items-center justify-center' : 'border-surface-variant/80'}">${iVotedForThis ? '<span class="material-symbols-outlined text-white text-[12px] font-bold">check</span>' : ''}</div>`;
            } else {
                selectorHtml = `<div class="w-4 h-4 rounded-full border-2 ${iVotedForThis ? 'border-primary flex items-center justify-center' : 'border-surface-variant/80'}">${iVotedForThis ? '<span class="w-2 h-2 rounded-full bg-primary"></span>' : ''}</div>`;
            }
        }

        let clickAction = '';
        let cursorClass = 'cursor-default';
        let opacityClass = canVote || iVotedForThis ? 'opacity-100' : 'opacity-60 grayscale-[50%]';

        if (canVote) {
            if (iVotedForThis && poll.can_undo_vote) {
                clickAction = `onclick="window.handlePollVote('${postId}', '${opt.id}', true)"`;
                cursorClass = 'cursor-pointer hover:bg-surface-variant/40';
            } else if (!iVotedForThis && (poll.is_multiple_choice || !userHasVoted || poll.can_undo_vote)) {
                clickAction = `onclick="window.handlePollVote('${postId}', '${opt.id}', false)"`;
                cursorClass = 'cursor-pointer hover:bg-surface-variant/40';
            }
        } else if (!canVote && !iVotedForThis) {
            clickAction = `onclick="import('./ui.js').then(({ showToast }) => showToast('${restrictionReason}', 'warning'))"`;
        }

        return `
        <div ${clickAction} class="relative w-full ${optBgClass} border ${optBorderClass} rounded-xl p-3 overflow-hidden transition-all mb-2 ${cursorClass} ${opacityClass}">
            <div class="absolute left-0 top-0 bottom-0 bg-primary/20 rounded-r-xl transition-all duration-700 ease-out" style="width: ${showResults && !isQuiz ? percentage : 0}%"></div>
            <div class="relative flex justify-between items-center text-[13px] font-bold text-on-surface dark:text-gray-100 z-10">
                <span class="flex items-center gap-2">${selectorHtml} ${opt.text}</span>
                <div class="flex items-center gap-2">
                    ${checkIconHtml}
                    <span class="${showResults ? 'opacity-100' : 'opacity-0'} transition-opacity">${percentage}%</span>
                </div>
            </div>
        </div>`;
    }).join('');

    let extraInfoHtml = '';
    if (showQuizAnswers && poll.extra_info) { // Explanation only shows when voted/ended
        extraInfoHtml = `
            <div class="mt-3 bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-[12.5px] text-on-surface dark:text-gray-200 animate-fadeIn">
                <span class="font-extrabold text-blue-600 dark:text-blue-400 block mb-0.5">${isQuiz ? 'Explanation' : 'Note'}</span>
                ${poll.extra_info}
            </div>
        `;
    }

    let quizBadge = isQuiz ? `<span class="bg-blue-500/10 text-blue-600 dark:text-blue-500 px-2 py-0.5 rounded text-[10px] font-extrabold uppercase tracking-widest mb-2 inline-block shadow-sm">Quiz</span>` : '';

    const totalVotesText = poll.voters_list_visibility === 'hidden' && !isAuthor
        ? `Votes hidden`
        : `<span class="${poll.voters_list_visibility === 'public' || isAuthor ? 'cursor-pointer hover:underline text-primary font-bold' : ''}" onclick="if('${poll.voters_list_visibility}' === 'public' || '${isAuthor}' === 'true') window.openPollVoters('${postId}')">${totalVotes} votes</span>`;

    let metaLabels = [];
    if (!poll.can_undo_vote) metaLabels.push('🔒 Cannot undo');
    if (poll.deadline_type === 'voter_count') metaLabels.push(`🎯 Target: ${poll.deadline_count}`);
    if (!isExpired && poll.deadline_type === 'time' && poll.deadline_time) metaLabels.push(`⏳ Ends in ${getPollTimeLeft(poll.deadline_time)}`);

    const metaHtml = metaLabels.length > 0 ? `<div class="text-[10px] font-bold text-on-surface-variant dark:text-gray-500 mt-3 pt-2 border-t border-surface-variant/30 dark:border-neutral-700 flex flex-wrap gap-x-3 gap-y-1 justify-center">${metaLabels.map(m => `<span>${m}</span>`).join('')}</div>` : '';

    const restrictionBannerHtml = restrictionReason ? `<div class="bg-surface-variant/20 dark:bg-neutral-800/50 text-[11px] font-bold text-on-surface-variant dark:text-gray-400 p-2 rounded-lg mb-3 text-center border border-surface-variant/40 dark:border-neutral-700">${restrictionReason}</div>` : '';

    const innerHtml = `
        ${quizBadge}
        ${restrictionBannerHtml}
        <div class="space-y-2 mb-2">${optionsHtml}</div>
        ${extraInfoHtml}
        <div class="flex justify-between items-center mt-3 text-[11px] font-medium text-on-surface-variant dark:text-gray-400">
            ${totalVotesText}
            <span>${isExpired ? 'Ended' : 'Ongoing'}</span>
        </div>
        ${metaHtml}
    `;

    return { innerHtml, isPollActive: !isExpired };
}

// The full post card — one post's worth of HTML. `currentUserId` drives
// like/save/vote/RSVP state; `currentUserAvatarUrl` is only used for the
// "Add a comment…" row's own-avatar thumbnail.
export function renderPostCardsHtml(posts, currentUserId, currentUserAvatarUrl) {
    return posts.map(post => {
        const user = post.users;
        if (!user) return '';

        const likes = post.post_likes || [];
        const likeCount = likes.length;
        const userHasLiked = likes.some(like => like.user_id === currentUserId);
        const savedPosts = post.saved_posts || [];
        const isSaved = savedPosts.some(s => s.user_id === currentUserId);

        let likedByHtml = '';
        if (likeCount > 0) {
            if (post.hide_likes) {
                const featuredLiker = likes.find(l => l.user_id !== currentUserId)?.users?.full_name || likes[0]?.users?.full_name || 'Someone';
                likedByHtml = likeCount === 1
                    ? `Liked by <span class="font-bold text-on-surface dark:text-gray-100">${featuredLiker}</span>`
                    : `Liked by <span class="font-bold text-on-surface dark:text-gray-100">${featuredLiker}</span> and <span onclick="window.openLikesModal('${post.id}')" class="font-bold text-on-surface dark:text-gray-100 cursor-pointer">others</span>`;
            } else {
                likedByHtml = `<span onclick="window.openLikesModal('${post.id}')" class="font-bold text-on-surface dark:text-gray-100 cursor-pointer">${likeCount} ${likeCount === 1 ? 'like' : 'likes'}</span>`;
            }
        }

        let commentsSectionHtml = '';
        if (!post.disable_comments) {
            const comments = (post.post_comments || []).filter(c => !c.is_deleted && c.content);
            const commentCount = comments.length;
            let commentsHtml = '';
            if (commentCount > 0) {
                const previewCount = commentCount > 1 ? `View all ${commentCount} comments` : 'View 1 comment';
                commentsHtml = `<p data-post-id="${post.id}" class="comment-btn text-[14px] text-on-surface-variant dark:text-gray-400 mt-1 cursor-pointer active:opacity-70">${previewCount}</p>`;

                const latestComment = comments[comments.length - 1];
                if (latestComment && latestComment.content) {
                    const cleanComment = latestComment.content.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ');
                    commentsHtml += `<p class="text-[14px] text-on-surface dark:text-gray-100 mt-1 leading-snug"><span class="font-bold mr-1 cursor-pointer">${latestComment.users?.full_name || 'User'}</span><span class="text-on-surface-variant dark:text-gray-300">${cleanComment}</span></p>`;
                }
            }

            commentsSectionHtml = `
                <div class="px-3 mt-1">${commentsHtml}</div>
                <div class="px-3 mt-2 flex items-center gap-2">
                    <img src="${currentUserAvatarUrl || 'https://ui-avatars.com/api/?name=User'}" class="w-6 h-6 rounded-full object-cover border border-surface-variant/50 shrink-0">
                    <p data-post-id="${post.id}" class="comment-btn flex-1 text-[13px] text-on-surface-variant dark:text-gray-500 cursor-text">Add a comment...</p>
                </div>
            `;
        }

        const isAnonymous = post.post_type === 'anonymous';

        // Anonymous posts show a fixed name/avatar and are never clickable
        // through to a profile — no .profile-link class, no data-user-id on
        // the header — so there's no way to tap through to the real author
        // from the feed. (The real user.id is still on the options button
        // below, which is how the true author's own edit/delete menu works.)
        const verifiedBadge = isAnonymous ? '' : (window.getTickHtml ? window.getTickHtml(user.tick_type) : '');
        const rawAvatarUrl = isAnonymous
            ? ANONYMOUS_AVATAR
            : (user.profile_img_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name)}&background=e1e3e4`);
        const optimizedAvatar = isAnonymous
            ? ANONYMOUS_AVATAR
            : (typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(rawAvatarUrl, 'avatar') : rawAvatarUrl);
        const headerIcon = isAnonymous
            ? `<img loading="lazy" src="${optimizedAvatar}" class="w-8 h-8 rounded-full border border-surface-variant shadow-sm object-cover shrink-0">`
            : `<img loading="lazy" src="${optimizedAvatar}" data-user-id="${user.id}" class="profile-link w-8 h-8 rounded-full border border-surface-variant shadow-sm object-cover cursor-pointer hover:opacity-80 transition-opacity shrink-0">`;
        const displayName = isAnonymous ? ANONYMOUS_NAME : user.full_name;
        const nameHtml = isAnonymous
            ? `<h4 class="font-bold text-[14px] text-on-surface dark:text-gray-100 leading-tight flex items-center gap-1 truncate">${displayName}</h4>`
            : `<h4 data-user-id="${user.id}" class="profile-link font-bold text-[14px] text-on-surface dark:text-gray-100 leading-tight cursor-pointer hover:text-primary transition-colors flex items-center gap-1 truncate">${displayName} ${verifiedBadge}</h4>`;

        // Robust empty post stripper (removes invisible Quill spaces)
        let cleanCaptionContent = post.content || '';
        const plainTextCheck = cleanCaptionContent.replace(/<[^>]*>?/gm, '').replace(/&nbsp;/g, '').trim();
        if (plainTextCheck === '' && !cleanCaptionContent.includes('<img') && !cleanCaptionContent.includes('<iframe')) {
            cleanCaptionContent = '';
        } else {
            cleanCaptionContent = cleanCaptionContent.replace(/^(<p><br><\/p>\s*)+/, '').replace(/(<p><br><\/p>\s*)+$/, '').trim();
        }

        let isPollActive = false;
        let contentHtml = '';

        if (post.post_type === 'text') {
            if (cleanCaptionContent !== '') {
                contentHtml = `<div class="px-4 py-8 mt-2 mb-2 bg-surface-variant/10 dark:bg-neutral-900/40 rounded-2xl mx-3 flex items-center justify-center border border-surface-variant/30 dark:border-neutral-800"><div class="text-[16px] sm:text-[18px] font-medium text-on-surface dark:text-gray-100 leading-relaxed whitespace-pre-wrap rich-text-content text-center w-full">${cleanCaptionContent}</div></div>`;
                cleanCaptionContent = ''; // Clear it so it doesn't render twice
            }
        }
        else if (post.post_type === 'anonymous') {
            if (cleanCaptionContent !== '') {
                contentHtml = `
                    <div class="mx-3 mt-2 mb-2 rounded-2xl overflow-hidden border border-surface-variant/30 dark:border-neutral-800">
                        <div class="px-3 pt-2 pb-1.5 flex items-center gap-1.5 bg-surface-variant/10 dark:bg-neutral-900/40 border-b border-surface-variant/20 dark:border-neutral-800/60">
                            <span class="material-symbols-outlined text-[14px] text-on-surface-variant dark:text-gray-400">theater_comedy</span>
                            <span class="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant dark:text-gray-400">Anonymous Post</span>
                        </div>
                        <div class="px-4 py-8 bg-surface-variant/10 dark:bg-neutral-900/40 flex items-center justify-center">
                            <div class="text-[16px] sm:text-[18px] font-medium text-on-surface dark:text-gray-100 leading-relaxed whitespace-pre-wrap rich-text-content text-center w-full">${cleanCaptionContent}</div>
                        </div>
                    </div>`;
                cleanCaptionContent = ''; // Clear it so it doesn't render twice
            }
        }
        else if (post.post_type === 'image') {
            contentHtml = `<div class="w-full bg-surface-variant/20 dark:bg-neutral-900 flex items-center justify-center border-y border-surface-variant/40 dark:border-neutral-800 mt-2"><img loading="lazy" src="${typeof window.optimizeImageUrl === 'function' ? window.optimizeImageUrl(post.media_url, 'feed') : post.media_url}" class="w-full h-auto max-h-[80vh] object-cover"></div>`;
        }
        else if (post.post_type === 'event') {
            const event = Array.isArray(post.post_events) ? post.post_events[0] : post.post_events;
            if (event) {
                const optimizedEventMedia = typeof window.optimizeImageUrl === 'function' && event.event_image_url ? window.optimizeImageUrl(event.event_image_url, 'feed') : event.event_image_url;
                const eventImgHtml = event.event_image_url ? `<img loading="lazy" src="${optimizedEventMedia}" class="w-full h-auto max-h-[80vh] object-cover border-y border-surface-variant/40 dark:border-neutral-800 mt-2">` : '';
                const dateStr = event.event_date ? new Date(event.event_date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'TBA';

                // Participation Model is mutually exclusive (set once, at
                // creation, via the radio group in index.html): a card is
                // either a register-link event OR an in-app RSVP event,
                // never both, so there's exactly one action button below.
                let actionHtml = '';
                let attendeeHtml = '';

                if (event.show_register_btn && event.register_url) {
                    const btnLabel = (event.register_button_text || '').trim() || 'Register Now';
                    const safeUrl = event.register_url.replace(/'/g, "\\'");
                    const safeTitle = btnLabel.replace(/'/g, "\\'");
                    const openInApp = !!event.register_open_in_app;
                    actionHtml = `<button type="button" onclick="window.openServiceLink ? window.openServiceLink('${safeUrl}', ${openInApp}, '${safeTitle}') : window.open('${safeUrl}', '_blank')" class="block w-full mt-3 bg-secondary text-white text-center py-2 rounded-xl text-[13px] font-bold active:scale-95 transition-transform">${btnLabel}</button>`;
                } else if (event.enable_rsvp) {
                    const rsvps = post.post_event_rsvps || [];
                    const isAttending = !!rsvps.find(r => r.user_id === currentUserId);
                    const btnClass = isAttending ? 'bg-surface-variant/50 text-on-surface dark:text-gray-100' : 'bg-primary text-white';
                    const btnText = isAttending ? '✓ Attending' : 'RSVP Now';
                    actionHtml = `<button onclick="window.handleRSVP('${post.id}', ${isAttending})" class="block w-full mt-3 ${btnClass} text-center py-2 rounded-xl text-[13px] font-bold active:scale-95 transition-all">${btnText}</button>`;

                    // "Who's going" — respects the RSVP List Visibility the
                    // organizer chose at creation time. Public: anyone can
                    // tap through to the attendee list. Hidden: only the
                    // organizer sees a (clickable) count; everyone else just
                    // sees the total, with no way to open the list.
                    const attendingCount = rsvps.filter(r => r.status === 'attending').length;
                    const isOrganizer = post.user_id === currentUserId;
                    const listIsPublic = (event.rsvp_list_visibility || 'public') === 'public';
                    const canOpenList = listIsPublic || isOrganizer;
                    const countLabel = attendingCount === 1 ? '1 going' : `${attendingCount} going`;

                    if (canOpenList) {
                        attendeeHtml = `<button type="button" onclick="window.openEventRsvps('${post.id}')" class="w-full mt-2 flex items-center justify-center gap-1.5 text-[12px] font-bold text-secondary active:opacity-70 transition-opacity">
                            <span class="material-symbols-outlined text-[15px]">groups</span>
                            ${attendingCount > 0 ? `${countLabel} · See who's attending` : `Be the first to RSVP`}
                        </button>`;
                    } else if (attendingCount > 0) {
                        attendeeHtml = `<p class="w-full mt-2 flex items-center justify-center gap-1.5 text-[12px] font-bold text-on-surface-variant dark:text-gray-400">
                            <span class="material-symbols-outlined text-[15px]">groups</span>
                            ${countLabel} <span class="material-symbols-outlined text-[13px]" title="Guest list hidden by the organizer">lock</span>
                        </p>`;
                    }
                }

                contentHtml = `
                    ${eventImgHtml}
                    <div class="px-3 py-3 bg-secondary/5 border-b border-secondary/20 dark:border-neutral-800">
                        <div class="bg-secondary/10 text-secondary w-max px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-2">Upcoming Event</div>
                        <div class="space-y-1">
                            <p class="text-[13px] text-on-surface-variant dark:text-gray-300 flex items-center gap-2 font-medium"><span class="material-symbols-outlined text-[16px]">calendar_today</span> ${dateStr}</p>
                            ${event.event_location ? `<p class="text-[13px] text-on-surface-variant dark:text-gray-300 flex items-center gap-2 font-medium"><span class="material-symbols-outlined text-[16px]">location_on</span> ${event.event_location}</p>` : ''}
                        </div>
                        ${actionHtml}
                        ${attendeeHtml}
                    </div>
                `;
            }
        }
        else if (post.post_type === 'poll') {
            const poll = Array.isArray(post.post_polls) ? post.post_polls[0] : post.post_polls;
            if (poll) {
                const votes = post.post_poll_votes || [];
                const { innerHtml, isPollActive: pollActive } = renderPollBodyHtml(post.id, poll, votes, post, currentUserId);
                isPollActive = pollActive;
                contentHtml = `
                    <div class="poll-container-wrapper px-3 py-3 border-y border-surface-variant/40 dark:border-neutral-800 bg-surface-variant/5 dark:bg-neutral-900/30 mt-2">
                        ${innerHtml}
                    </div>
                `;
            }
        }

        // Skip rendering if it's an empty, broken post
        if (contentHtml === '' && cleanCaptionContent === '' && (post.post_type === 'text' || post.post_type === 'anonymous')) return '';

        let topCaptionHtml = '';
        let bottomCaptionHtml = '';

        if (cleanCaptionContent !== '') {
            if (post.post_type === 'image') {
                bottomCaptionHtml = `<div class="px-3 text-[14px] text-on-surface dark:text-gray-100 leading-snug mt-1.5 mb-1"><span data-user-id="${user.id}" class="profile-link font-bold mr-1 cursor-pointer hover:underline">${user.full_name}</span><span class="rich-text-content inline">${cleanCaptionContent}</span></div>`;
            } else {
                topCaptionHtml = `<div class="px-3 text-[15px] text-on-surface dark:text-gray-100 leading-snug mt-2 mb-1"><span class="rich-text-content inline">${cleanCaptionContent}</span></div>`;
            }
        }

        return `
        <div data-post-id="${post.id}" class="bg-surface dark:bg-[#121212] mb-6 animate-fadeIn pb-4 border-b border-surface-variant/40 dark:border-neutral-800 relative">

            <div class="flex items-center gap-3 px-3 py-2">
                ${headerIcon}
                <div class="flex-1 min-w-0">
                    ${nameHtml}
                </div>
                <button data-post-id="${post.id}" data-user-id="${user.id}" data-is-verified="${post.is_verified}" data-hide-likes="${post.hide_likes}" data-disable-comments="${post.disable_comments}" data-is-archived="${post.is_archived || false}" data-post-type="${post.post_type}" data-is-poll-active="${isPollActive}" class="post-options-btn text-on-surface dark:text-gray-100 p-1.5 active:opacity-60 transition-opacity">
                    <span class="material-symbols-outlined text-[20px]">more_vert</span>
                </button>
            </div>

            ${topCaptionHtml}
            ${contentHtml}

            <div class="flex items-center justify-between px-3 py-2 mt-1">
                <div class="flex items-center gap-3.5">
                    <button onclick="window.handleLike('${post.id}', this)" data-post-id="${post.id}" data-liked="${userHasLiked}" class="like-btn flex items-center justify-center transition-all duration-200 active:scale-75 ${userHasLiked ? 'text-red-500 hover:text-red-600' : 'text-on-surface dark:text-gray-100 hover:opacity-70'}">
                        <span class="material-symbols-outlined text-[28px]" style="font-variation-settings: 'FILL' ${userHasLiked ? 1 : 0};">favorite</span>
                    </button>
                    ${!post.disable_comments ? `
                    <button data-post-id="${post.id}" class="comment-btn flex items-center justify-center text-on-surface dark:text-gray-100 transition-all duration-200 active:scale-75 hover:opacity-70">
                        <span class="material-symbols-outlined text-[26px]" style="transform: scaleX(-1);">chat_bubble_outline</span>
                    </button>` : ''}
                    <button onclick="window.shareFeedPost('${post.id}', '${(user.full_name || '').replace(/'/g, "\\'")}')" class="flex items-center justify-center text-on-surface dark:text-gray-100 transition-all duration-200 active:scale-75 hover:opacity-70">
                        <svg aria-label="Share" class="w-[25px] h-[25px]" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2" viewBox="0 0 24 24"><line x1="22" x2="9.218" y1="3" y2="10.083"></line><polygon points="11.698 20.334 22 3.001 2 3.001 9.218 10.084 11.698 20.334"></polygon></svg>
                    </button>
                </div>
                <button onclick="window.handleSavePost('${post.id}', this)" data-post-id="${post.id}" data-saved="${isSaved}" class="save-btn flex items-center justify-center transition-all duration-200 active:scale-75 ${isSaved ? 'text-primary hover:text-primary/80' : 'text-on-surface dark:text-gray-100 hover:opacity-70'}">
                    <span class="material-symbols-outlined text-[28px]" style="font-variation-settings: 'FILL' ${isSaved ? 1 : 0};">bookmark</span>
                </button>
            </div>

            ${likeCount > 0 ? `<div class="px-3 mb-1 text-[14px] text-on-surface dark:text-gray-100">${likedByHtml}</div>` : ''}

            ${bottomCaptionHtml}

            ${commentsSectionHtml}
            <p class="px-3 text-[11px] text-on-surface-variant dark:text-gray-500 mt-2 uppercase tracking-wide">${timeAgo(post.created_at)}</p>
        </div>
        `;
    }).join('');
}
