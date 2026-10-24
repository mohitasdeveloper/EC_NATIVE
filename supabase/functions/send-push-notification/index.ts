import { createClient } from "npm:@supabase/supabase-js@2";
import { JWT } from "npm:google-auth-library";

Deno.serve(async (req) => {
  try {
    // 1. Parse the incoming database webhook event payload
    const payload = await req.json();
    
    // Only process row insertions
    if (payload.type !== "INSERT") {
      return new Response("Skipping: Event is not an INSERT", { status: 200 });
    }

    const record = payload.record; 
    const { user_id, sender_id, type, message, target_id } = record;

    // Hotposts and Messages were removed from the app. The database cleanup
    // (supabase/cleanup_hotposts_messages.sql) deletes the triggers that created
    // these rows, but if one ever slips through (an old app build, a stale
    // function) it must NOT turn into a generic "New Activity" push.
    const REMOVED_TYPES = ['hotpost_like', 'hotpost_reply', 'page_new_hotpost', 'new_message', 'page_message'];
    if (REMOVED_TYPES.includes(type)) {
      return new Response(`Skipping: '${type}' notifications no longer exist.`, { status: 200 });
    }

    // 2. Initialize internal Supabase Client
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 3. Fetch the recipient's FCM push token AND their Push Settings
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("fcm_token, push_settings")
      .eq("id", user_id)
      .single();

    if (userError || !user?.fcm_token) {
      console.log(`Notification skipped: User ${user_id} has no registered fcm_token.`);
      return new Response("No registered FCM token found for user.", { status: 200 });
    }

    // 4. GATEKEEPER LOGIC: Check if the user turned off this specific notification category
    const settings = user.push_settings || {};
    let category = 'all';
    
    if (['post_like', 'comment_like'].includes(type)) category = 'likes';
    else if (['post_comment', 'comment_reply'].includes(type)) category = 'comments';
    else if (['post_mention', 'comment_mention'].includes(type)) category = 'mentions';
    else if (['connection_request', 'connection_accepted', 'new_follower'].includes(type)) category = 'connections';

    // If the user explicitly set this category to false, abort sending the push!
    if (settings[category] === false) {
      console.log(`Push skipped: User ${user_id} disabled notifications for ${category}.`);
      return new Response(`Push disabled by user for category: ${category}`, { status: 200 });
    }

    // 5. Fetch the SENDER'S name so the push text is personalized
    let senderName = "Someone";
    if (sender_id) {
      const { data: senderData } = await supabase
        .from("users")
        .select("full_name")
        .eq("id", sender_id)
        .single();
      if (senderData?.full_name) {
        senderName = senderData.full_name;
      }
    }

    // 6. Parse the Firebase credentials
    const serviceAccountRaw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
    if (!serviceAccountRaw) {
      throw new Error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
    }
    const serviceAccount = JSON.parse(serviceAccountRaw);

    // Clean up the private key line breaks
    const cleanPrivateKey = serviceAccount.private_key.replace(/\\n/g, '\n');

    // 7. Generate secure Google OAuth2 Access Token
    const jwtClient = new JWT({
      email: serviceAccount.client_email,
      key: cleanPrivateKey,
      scopes: ["https://www.googleapis.com/auth/firebase.messaging"]
    });
    
    const tokens = await jwtClient.authorize();
    const accessToken = tokens.access_token;

    // 8. Map internal types to matching Titles
    const titleMap: Record<string, string> = {
      'post_like': '❤️ New Like',
      'post_comment': '💬 New Comment',
      'comment_like': '❤️ Comment Liked',
      'comment_reply': '💬 New Reply',
      'post_mention': '🏷️ You were mentioned',
      'comment_mention': '🏷️ You were mentioned',
      'connection_request': '👋 Connection Request',
      'connection_accepted': '🤝 Connection Accepted',
      'new_follower': '👤 New Follower',
      'page_new_post': '📢 New Post',
    };
    const notificationTitle = titleMap[type] || '📢 New Activity';

    // 9. Dynamic Body generation (Formatting out HTML tags securely)
    let notificationBody = "You have a new update waiting on ECampus.";
    
    if (type === 'post_like') {
      notificationBody = `${senderName} liked your post.`;
    } else if (type === 'post_comment') {
      notificationBody = `${senderName} commented: "${message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}"`;
    } else if (type === 'comment_like') {
      notificationBody = `${senderName} liked your comment.`;
    } else if (type === 'comment_reply') {
      notificationBody = `${senderName} replied to your comment: "${message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}"`;
    } else if (type === 'post_mention') {
      notificationBody = `${senderName} mentioned you in a post: "${message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}"`;
    } else if (type === 'comment_mention') {
      notificationBody = `${senderName} mentioned you in a comment: "${message.replace(/<[^>]*>?/gm, '').replace(/\u00A0/g, ' ')}"`;
    } else if (type === 'connection_accepted') {
      notificationBody = `${senderName} accepted your connection request.`;
    } else if (type === 'connection_request') {
      notificationBody = `${senderName} sent you a connection request.`;
    } else if (type === 'new_follower') {
      notificationBody = `${senderName} started following you.`;
    } else if (type === 'page_new_post') {
      notificationBody = `${senderName} published a new post.`;
    }

    // 10. Structure the official Firebase payload format
    const fcmPayload = {
      message: {
        token: user.fcm_token,
        notification: {
          title: notificationTitle,
          body: notificationBody,
        },
        data: {
          type: type,
          target_id: target_id || "",
          sender_id: sender_id || "",
        },
        android: {
          notification: {
            sound: "default",
            // 🚀 THE FIX: This MUST match the intent-filter in AndroidManifest.xml
            click_action: "FCM_PLUGIN_ACTIVITY" 
          }
        }
      }
    };
    // 11. Forward request securely to Google API
    const fcmResponse = await fetch(
      `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(fcmPayload),
      }
    );

    const fcmResult = await fcmResponse.json();
    console.log("Firebase API delivery result:", fcmResult);

    return new Response(JSON.stringify({ success: true, fcmResult }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });

  } catch (err) {
    console.error("Critical error inside push Edge Function:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    });
  }
});
