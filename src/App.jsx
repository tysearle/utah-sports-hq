import { useState, useEffect, useCallback, useRef } from "react";
import {
  auth, db, storage, googleProvider,
  signInWithPopup, signOut,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, updatePassword,
  EmailAuthProvider, reauthenticateWithCredential,
} from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, setDoc, getDoc, deleteDoc, collection, getDocs, query, orderBy } from "firebase/firestore";
// Firebase Storage removed — profile pics stored as base64 in Firestore (Spark plan compatible)
import BracketChallenge, { loadUserEntries } from "./BracketChallenge";

// --- Admin Config ---
const ADMIN_EMAILS = ["t.m.searle@gmail.com"];

// --- Compress image to base64 data URL (stored in Firestore, no Firebase Storage needed) ---
function compressImageToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const size = 200;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --- Register/update user in Firestore ---
async function registerUser(u, extra = {}) {
  if (!u) return;
  try {
    await setDoc(doc(db, "users", u.uid), {
      uid: u.uid,
      email: u.email || null,
      lastLogin: new Date().toISOString(),
      ...extra,
    }, { merge: true });
  } catch (e) {
    console.error("User registration error:", e);
  }
}

async function loadUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) return snap.data();
  } catch (e) {
    console.error("Profile load error:", e);
  }
  return null;
}

// --- Auth Hook ---
function useAuth() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const p = await loadUserProfile(u.uid);
        setProfile(p);
        // Update lastLogin
        registerUser(u, p?.username ? {} : { displayName: u.displayName || "Anonymous", photoURL: u.photoURL || null });
      } else {
        setProfile(null);
      }
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  const refreshProfile = async () => {
    if (user) {
      const p = await loadUserProfile(user.uid);
      setProfile(p);
    }
  };

  const loginWithGoogle = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      if (result.user) {
        const existing = await loadUserProfile(result.user.uid);
        if (!existing?.username) {
          // First time Google user — needs to set username
          await registerUser(result.user, {
            displayName: result.user.displayName || "Anonymous",
            photoURL: result.user.photoURL || null,
          });
        } else {
          await registerUser(result.user);
        }
        const p = await loadUserProfile(result.user.uid);
        setProfile(p);
      }
    } catch (e) {
      console.error("Google sign-in error:", e);
    }
  };

  const signupWithEmail = async (email, password, username, profilePicFile) => {
    try {
      const result = await createUserWithEmailAndPassword(auth, email, password);
      const u = result.user;
      let photoURL = null;
      if (profilePicFile) {
        photoURL = await compressImageToDataURL(profilePicFile);
      }
      await registerUser(u, { username, displayName: username, photoURL });
      const p = await loadUserProfile(u.uid);
      setProfile(p);
      // Send welcome email (fire-and-forget)
      fetch("/api/welcome-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username }),
      }).catch(() => {});
      return { success: true };
    } catch (e) {
      console.error("Signup error:", e);
      return { success: false, error: e.message };
    }
  };

  const loginWithEmail = async (email, password) => {
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      const p = await loadUserProfile(result.user.uid);
      setProfile(p);
      await registerUser(result.user);
      return { success: true };
    } catch (e) {
      console.error("Login error:", e);
      return { success: false, error: e.message };
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setProfile(null);
    } catch (e) {
      console.error("Sign-out error:", e);
    }
  };

  const isAdmin = user && ADMIN_EMAILS.includes(user.email);

  return { user, profile, authLoading, loginWithGoogle, signupWithEmail, loginWithEmail, logout, isAdmin, refreshProfile };
}

// --- Auth Modal ---
function AuthModal({ onClose, onLoginGoogle, onSignupEmail, onLoginEmail }) {
  const [mode, setMode] = useState("login"); // "login" | "signup" | "forgot"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");
  const [profilePic, setProfilePic] = useState(null);
  const [profilePicPreview, setProfilePicPreview] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [showTos, setShowTos] = useState(false);
  const [showPrivacyInAuth, setShowPrivacyInAuth] = useState(false);

  const handlePicChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("Image must be under 2MB"); return; }
    setProfilePic(file);
    const reader = new FileReader();
    reader.onload = (ev) => setProfilePicPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const [resetSent, setResetSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    if (mode === "forgot") {
      try {
        await sendPasswordResetEmail(auth, email);
        setResetSent(true);
      } catch (err) {
        setError(err.message?.replace("Firebase: ", "") || "Failed to send reset email");
      }
      setLoading(false);
      return;
    }
    if (mode === "signup") {
      if (!username.trim()) { setError("Username is required"); setLoading(false); return; }
      if (username.trim().length < 3) { setError("Username must be at least 3 characters"); setLoading(false); return; }
      if (password.length < 6) { setError("Password must be at least 6 characters"); setLoading(false); return; }
      if (!ageConfirmed) { setError("You must confirm you are 18+ and agree to the Terms of Service"); setLoading(false); return; }
      const result = await onSignupEmail(email, password, username.trim(), profilePic);
      if (!result.success) setError(result.error?.replace("Firebase: ", "") || "Signup failed");
      else onClose();
    } else {
      const result = await onLoginEmail(email, password);
      if (!result.success) setError(result.error?.replace("Firebase: ", "") || "Login failed");
      else onClose();
    }
    setLoading(false);
  };

  const inputStyle = {
    width: "100%", background: "#0a0a16", border: "1px solid #2a2a3e", borderRadius: 8,
    padding: "10px 14px", color: "#ccc", fontSize: 13, outline: "none", boxSizing: "border-box",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 16,
        padding: 28, width: "100%", maxWidth: 380, position: "relative",
      }} onClick={(e) => e.stopPropagation()}>
        {/* Close button */}
        <button onClick={onClose} style={{
          position: "absolute", top: 12, right: 12, background: "none",
          border: "none", color: "#666", fontSize: 18, cursor: "pointer",
        }}>✕</button>

        <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#fff", textAlign: "center" }}>
          {mode === "signup" ? "Create Account" : mode === "forgot" ? "Reset Password" : "Welcome Back"}
        </h2>
        <p style={{ margin: "0 0 20px", fontSize: 12, color: "#666", textAlign: "center" }}>
          {mode === "signup" ? "Pick a username — only this will be visible to others" : mode === "forgot" ? "Enter your email and we'll send a reset link" : "Sign in to your account"}
        </p>

        <form onSubmit={handleSubmit}>
          {mode === "signup" && (
            <>
              {/* Profile Picture */}
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <label style={{ cursor: "pointer", display: "inline-block" }}>
                  <input type="file" accept="image/*" onChange={handlePicChange} style={{ display: "none" }} />
                  {profilePicPreview ? (
                    <img src={profilePicPreview} alt="" style={{
                      width: 64, height: 64, borderRadius: "50%", objectFit: "cover",
                      border: "3px solid #CC0000",
                    }} />
                  ) : (
                    <div style={{
                      width: 64, height: 64, borderRadius: "50%", background: "#1a1a2e",
                      border: "2px dashed #2a2a3e", display: "flex", alignItems: "center",
                      justifyContent: "center", flexDirection: "column", gap: 2,
                    }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                      <span style={{ fontSize: 8, color: "#555" }}>Add Photo</span>
                    </div>
                  )}
                </label>
                <div style={{ fontSize: 9, color: "#444", marginTop: 4 }}>Optional — max 2MB</div>
              </div>

              {/* Username */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>Username</label>
                <input type="text" value={username} onChange={(e) => setUsername(e.target.value.slice(0, 20))}
                  placeholder="Choose a username" maxLength={20} required style={inputStyle}
                  onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
                  onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
                />
              </div>
            </>
          )}

          {/* Email */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com" required style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
              onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
            />
          </div>

          {/* Password (hidden in forgot mode) */}
          {mode !== "forgot" && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>Password</label>
              <div style={{ position: "relative" }}>
                <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "signup" ? "Min 6 characters" : "Your password"} required
                  style={{ ...inputStyle, paddingRight: 44 }}
                  onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
                  onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                    background: "none", border: "none", color: "#888", fontSize: 11,
                    cursor: "pointer", padding: "4px 6px", borderRadius: 4,
                  }}
                  onMouseEnter={(e) => (e.target.style.color = "#ccc")}
                  onMouseLeave={(e) => (e.target.style.color = "#888")}
                >
                  {showPassword ? "Hide" : "Show"}
                </button>
              </div>
            </div>
          )}

          {/* Forgot password link */}
          {mode === "login" && (
            <div style={{ textAlign: "right", marginTop: -8, marginBottom: 12 }}>
              <button type="button" onClick={() => { setMode("forgot"); setError(""); setResetSent(false); }}
                style={{ background: "none", border: "none", color: "#888", fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                Forgot password?
              </button>
            </div>
          )}

          {/* Age & Terms checkbox (signup only) */}
          {mode === "signup" && (
            <label style={{
              display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14,
              cursor: "pointer", fontSize: 11, color: "#aaa", lineHeight: 1.5,
            }}>
              <input type="checkbox" checked={ageConfirmed} onChange={(e) => setAgeConfirmed(e.target.checked)}
                style={{ marginTop: 2, accentColor: "#CC0000", flexShrink: 0 }}
              />
              <span>I confirm I am at least 18 years old and agree to the <button type="button" onClick={() => setShowTos(true)} style={{ background: "none", border: "none", color: "#CC0000", fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}>Terms of Service</button> and <button type="button" onClick={() => setShowPrivacyInAuth(true)} style={{ background: "none", border: "none", color: "#CC0000", fontSize: 11, cursor: "pointer", padding: 0, textDecoration: "underline" }}>Privacy Policy</button>.</span>
            </label>
          )}

          {error && (
            <div style={{ background: "#CC000015", border: "1px solid #CC000044", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 11, color: "#CC0000" }}>
              {error}
            </div>
          )}

          {resetSent && mode === "forgot" && (
            <div style={{ background: "#4CAF5015", border: "1px solid #4CAF5044", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 11, color: "#4CAF50" }}>
              Reset link sent! Check your email inbox.
              <div style={{ color: "#FFD700", marginTop: 4, fontSize: 10 }}>⚠️ Don't see it? Check your spam or junk folder.</div>
            </div>
          )}

          <button type="submit" disabled={loading || (mode === "forgot" && resetSent)} style={{
            width: "100%", background: (mode === "forgot" && resetSent) ? "#1a1a2e" : "#CC0000", border: "none", borderRadius: 8,
            padding: "12px", color: (mode === "forgot" && resetSent) ? "#666" : "#fff", fontSize: 14, fontWeight: 700,
            cursor: loading ? "wait" : "pointer", transition: "all 0.2s", marginBottom: 12,
          }}>
            {loading ? "..." : mode === "signup" ? "Create Account" : mode === "forgot" ? (resetSent ? "Email Sent" : "Send Reset Link") : "Sign In"}
          </button>
        </form>

        {/* Divider + Google (not shown in forgot mode) */}
        {mode !== "forgot" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
              <div style={{ flex: 1, height: 1, background: "#2a2a3e" }} />
              <span style={{ fontSize: 10, color: "#555" }}>or</span>
              <div style={{ flex: 1, height: 1, background: "#2a2a3e" }} />
            </div>

            <button onClick={async () => { await onLoginGoogle(); onClose(); }} style={{
              width: "100%", background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
              padding: "10px", color: "#ccc", fontSize: 12, fontWeight: 600,
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              transition: "all 0.2s", marginBottom: 16,
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#ffffff0a")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#1a1a2e")}
            >
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Continue with Google
            </button>
          </>
        )}

        {/* Toggle */}
        <div style={{ textAlign: "center", fontSize: 12, color: "#888" }}>
          {mode === "forgot" ? (
            <>Remember your password? <button onClick={() => { setMode("login"); setError(""); setResetSent(false); }} style={{ background: "none", border: "none", color: "#CC0000", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0, textDecoration: "underline" }}>Sign in</button></>
          ) : mode === "login" ? (
            <>Don't have an account? <button onClick={() => { setMode("signup"); setError(""); }} style={{ background: "none", border: "none", color: "#CC0000", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0, textDecoration: "underline" }}>Sign up</button></>
          ) : (
            <>Already have an account? <button onClick={() => { setMode("login"); setError(""); }} style={{ background: "none", border: "none", color: "#CC0000", cursor: "pointer", fontSize: 12, fontWeight: 600, padding: 0, textDecoration: "underline" }}>Sign in</button></>
          )}
        </div>
      </div>

      {/* Terms of Service overlay inside Auth */}
      {showTos && (
        <div onClick={() => setShowTos(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 10001,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#12121f", borderRadius: 16, border: "1px solid #2a2a3e",
            maxWidth: 600, width: "100%", maxHeight: "80vh", overflowY: "auto", padding: "24px 20px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#fff" }}>Terms of Service</h3>
              <button onClick={() => setShowTos(false)} style={{ background: "#2a2a3e", border: "none", borderRadius: 8, color: "#aaa", width: 30, height: 30, fontSize: 16, cursor: "pointer" }}>&times;</button>
            </div>
            <div style={{ fontSize: 12, color: "#ccc", lineHeight: 1.75 }}>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>1. Acceptance.</strong> By creating an account on Salt City Sports (saltcitysportsutah.com), you agree to these Terms of Service. If you do not agree, do not create an account or use the site.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>2. Eligibility.</strong> You must be at least 18 years of age to create an account. By registering, you represent that you are 18 or older and that all information you provide is truthful and accurate.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>3. Accounts.</strong> You are responsible for maintaining the security of your account. You agree not to share your login credentials. We reserve the right to suspend or terminate accounts that violate these Terms.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>4. User Content.</strong> You are responsible for all content you post, including chat messages, display names, and profile pictures. You agree not to post content that is abusive, threatening, defamatory, obscene, or illegal. We reserve the right to remove content and suspend accounts that violate this policy.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>5. Sports Data.</strong> Scores, schedules, standings, statistics, and news displayed on this site are sourced from third-party providers and are for entertainment and informational purposes only. We do not guarantee the accuracy, completeness, or timeliness of this data. Do not rely on it for betting, financial, or other decisions.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>6. Contests.</strong> Participation in contests (such as bracket challenges) is subject to the Official Contest Rules posted on the relevant page. Contests are skill-based, free to enter, and not gambling.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>7. Intellectual Property.</strong> Salt City Sports is an independent fan site. Team names, logos, and league marks are the property of their respective owners. "March Madness" is a registered trademark of the NCAA. We are not affiliated with, endorsed by, or sponsored by any professional or collegiate sports league, team, or ESPN.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>8. Affiliate Links.</strong> Some links on this site (such as ticket purchase links) are affiliate links. We may earn a small commission from purchases made through these links at no additional cost to you.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>9. Limitation of Liability.</strong> Salt City Sports is provided "as is" without warranties of any kind. We are not liable for any damages arising from your use of the site, including data loss, service interruptions, or inaccurate sports data.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>10. Changes.</strong> We may update these Terms at any time. Continued use of the site after changes constitutes acceptance. Material changes will be communicated via a notice on the site.</p>
              <p style={{ marginBottom: 0, color: "#888" }}><strong style={{ color: "#aaa" }}>11. Governing Law.</strong> These Terms are governed by the laws of the State of Utah. Contact: saltcitysportsutah@gmail.com</p>
            </div>
          </div>
        </div>
      )}

      {/* Privacy Policy overlay inside Auth */}
      {showPrivacyInAuth && (
        <div onClick={() => setShowPrivacyInAuth(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 10001,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#12121f", borderRadius: 16, border: "1px solid #2a2a3e",
            maxWidth: 600, width: "100%", maxHeight: "80vh", overflowY: "auto", padding: "24px 20px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#fff" }}>Privacy Policy</h3>
              <button onClick={() => setShowPrivacyInAuth(false)} style={{ background: "#2a2a3e", border: "none", borderRadius: 8, color: "#aaa", width: 30, height: 30, fontSize: 16, cursor: "pointer" }}>&times;</button>
            </div>
            <div style={{ fontSize: 12, color: "#ccc", lineHeight: 1.75 }}>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>What We Collect.</strong> Email address, display name, profile photos, bracket picks, chat messages, and anonymous usage data via Google Analytics (GA4).</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>How We Use It.</strong> To provide our services — team preferences, bracket entries, leaderboards, and chat. Analytics help us improve the site. We do not sell or share your data.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>Cookies.</strong> Essential cookies for authentication (Firebase Auth) and anonymous analytics (Google Analytics). No advertising cookies.</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>Third Parties.</strong> Firebase (authentication/database), Google Analytics, and affiliate partners (SeatGeek via Impact.com).</p>
              <p style={{ marginBottom: 12 }}><strong style={{ color: "#fff" }}>Your Rights.</strong> You can request account and data deletion at any time. CCPA and GDPR rights apply where applicable.</p>
              <p style={{ marginBottom: 0, color: "#888" }}><strong style={{ color: "#aaa" }}>Contact.</strong> saltcitysportsutah@gmail.com &nbsp;|&nbsp; Full policy available in the site footer.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Profile Settings Modal ---
function ProfileSettingsModal({ user, profile, onClose, onProfileUpdated }) {
  const [newPic, setNewPic] = useState(null);
  const [newPicPreview, setNewPicPreview] = useState(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [picSuccess, setPicSuccess] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [error, setError] = useState("");

  const isEmailUser = user?.providerData?.some((p) => p.providerId === "password");

  const inputStyle = {
    width: "100%", padding: "10px 12px", background: "#0d0d1a", border: "1px solid #2a2a3e",
    borderRadius: 8, color: "#fff", fontSize: 13, outline: "none", transition: "border-color 0.2s",
    boxSizing: "border-box",
  };

  const handlePicChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("Image must be under 2MB"); return; }
    setNewPic(file);
    setNewPicPreview(URL.createObjectURL(file));
    setError("");
  };

  const handlePicUpload = async () => {
    if (!newPic) return;
    setLoading(true); setError(""); setPicSuccess("");
    try {
      const photoURL = await compressImageToDataURL(newPic);
      await setDoc(doc(db, "users", user.uid), { photoURL }, { merge: true });
      setPicSuccess("Profile picture updated!");
      setNewPic(null);
      if (onProfileUpdated) onProfileUpdated();
    } catch (e) {
      setError("Failed to upload: " + e.message);
    }
    setLoading(false);
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setError(""); setPwSuccess("");
    if (newPassword.length < 6) { setError("New password must be at least 6 characters"); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }
    setLoading(true);
    try {
      const credential = EmailAuthProvider.credential(user.email, currentPassword);
      await reauthenticateWithCredential(user, credential);
      await updatePassword(user, newPassword);
      setPwSuccess("Password updated successfully!");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    } catch (e) {
      if (e.code === "auth/wrong-password" || e.code === "auth/invalid-credential") {
        setError("Current password is incorrect");
      } else {
        setError("Failed to update password: " + e.message);
      }
    }
    setLoading(false);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 10000, padding: 16,
    }} onClick={onClose}>
      <div style={{
        background: "#1a1a2e", borderRadius: 16, padding: 24, width: "100%", maxWidth: 400,
        border: "1px solid #2a2a3e", maxHeight: "85vh", overflowY: "auto",
      }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ color: "#fff", margin: 0, fontSize: 18 }}>Profile Settings</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#888", fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>

        {/* Current profile info */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, padding: 12, background: "#0d0d1a", borderRadius: 10 }}>
          {profile?.photoURL ? (
            <img src={profile.photoURL} alt="" style={{ width: 44, height: 44, borderRadius: "50%", border: "2px solid #CC0000", objectFit: "cover" }} referrerPolicy="no-referrer" />
          ) : (
            <div style={{ width: 44, height: 44, borderRadius: "50%", background: "#CC000033", border: "2px solid #CC0000", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "#CC0000" }}>
              {(profile?.username || user.email || "?")[0].toUpperCase()}
            </div>
          )}
          <div>
            <div style={{ color: "#fff", fontWeight: 600, fontSize: 14 }}>{profile?.username || "No username"}</div>
            <div style={{ color: "#888", fontSize: 11 }}>{user.email}</div>
          </div>
        </div>

        {/* Change Profile Picture */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: "#aaa", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Change Profile Picture</div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {newPicPreview ? (
              <img src={newPicPreview} alt="" style={{ width: 50, height: 50, borderRadius: "50%", objectFit: "cover", border: "2px solid #CC0000" }} />
            ) : (
              <div style={{ width: 50, height: 50, borderRadius: "50%", background: "#0d0d1a", border: "2px dashed #2a2a3e", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
              </div>
            )}
            <div style={{ flex: 1 }}>
              <label style={{
                display: "inline-block", padding: "6px 14px", background: "#CC000022", border: "1px solid #CC000066",
                borderRadius: 8, color: "#CC0000", fontSize: 11, fontWeight: 600, cursor: "pointer",
              }}>
                Choose Photo
                <input type="file" accept="image/*" onChange={handlePicChange} style={{ display: "none" }} />
              </label>
              {newPic && (
                <button onClick={handlePicUpload} disabled={loading} style={{
                  marginLeft: 8, padding: "6px 14px", background: "#CC0000", border: "none",
                  borderRadius: 8, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer",
                }}>
                  {loading ? "..." : "Save"}
                </button>
              )}
            </div>
          </div>
          <div style={{ fontSize: 9, color: "#444", marginTop: 4 }}>Max 2MB. JPG or PNG recommended.</div>
          {picSuccess && <div style={{ fontSize: 11, color: "#4CAF50", marginTop: 6 }}>{picSuccess}</div>}
        </div>

        {/* Change Password (email users only) */}
        {isEmailUser ? (
          <div>
            <div style={{ fontSize: 12, color: "#aaa", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Change Password</div>
            <form onSubmit={handlePasswordChange}>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>Current Password</label>
                <div style={{ position: "relative" }}>
                  <input type={showCurrentPw ? "text" : "password"} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                    required style={{ ...inputStyle, paddingRight: 44 }}
                    onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
                    onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
                  />
                  <button type="button" onClick={() => setShowCurrentPw(!showCurrentPw)}
                    style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#888", fontSize: 11, cursor: "pointer", padding: "4px 6px" }}>
                    {showCurrentPw ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>New Password</label>
                <div style={{ position: "relative" }}>
                  <input type={showNewPw ? "text" : "password"} value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Min 6 characters" required style={{ ...inputStyle, paddingRight: 44 }}
                    onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
                    onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
                  />
                  <button type="button" onClick={() => setShowNewPw(!showNewPw)}
                    style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#888", fontSize: 11, cursor: "pointer", padding: "4px 6px" }}>
                    {showNewPw ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block" }}>Confirm New Password</label>
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password" required style={inputStyle}
                  onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
                  onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
                />
              </div>
              <button type="submit" disabled={loading} style={{
                width: "100%", background: "#CC0000", border: "none", borderRadius: 8,
                padding: "10px", color: "#fff", fontSize: 13, fontWeight: 700, cursor: loading ? "wait" : "pointer",
              }}>
                {loading ? "Updating..." : "Update Password"}
              </button>
            </form>
            {pwSuccess && <div style={{ fontSize: 11, color: "#4CAF50", marginTop: 8 }}>{pwSuccess}</div>}
          </div>
        ) : (
          <div style={{ padding: 12, background: "#0d0d1a", borderRadius: 10, fontSize: 12, color: "#888" }}>
            Password changes are not available for Google sign-in accounts. You can manage your Google password through your Google account settings.
          </div>
        )}

        {error && (
          <div style={{ background: "#CC000015", border: "1px solid #CC000044", borderRadius: 8, padding: "8px 12px", marginTop: 12, fontSize: 11, color: "#CC0000" }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Username Setup for Google Users ---
function UsernameSetupModal({ user, onDone }) {
  const [username, setUsername] = useState("");
  const [profilePic, setProfilePic] = useState(null);
  const [profilePicPreview, setProfilePicPreview] = useState(user?.photoURL || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handlePicChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setError("Image must be under 2MB"); return; }
    setProfilePic(file);
    const reader = new FileReader();
    reader.onload = (ev) => setProfilePicPreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleSave = async () => {
    if (!username.trim() || username.trim().length < 3) {
      setError("Username must be at least 3 characters");
      return;
    }
    setSaving(true);
    setError("");
    try {
      let photoURL = user.photoURL || null;
      if (profilePic) {
        photoURL = await compressImageToDataURL(profilePic);
      }
      await setDoc(doc(db, "users", user.uid), {
        username: username.trim(),
        displayName: username.trim(),
        photoURL,
      }, { merge: true });
      // Send welcome email for Google users (fire-and-forget)
      if (user.email) {
        fetch("/api/welcome-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: user.email, username: username.trim() }),
        }).catch(() => {});
      }
      onDone();
    } catch (e) {
      setError("Failed to save: " + e.message);
    }
    setSaving(false);
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "rgba(0,0,0,0.8)", backdropFilter: "blur(4px)",
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16,
    }}>
      <div style={{
        background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 16,
        padding: 28, width: "100%", maxWidth: 360, textAlign: "center",
      }}>
        <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: "#fff" }}>
          Set Your Username
        </h2>
        <p style={{ margin: "0 0 20px", fontSize: 12, color: "#666" }}>
          Only your username will be visible to other users
        </p>

        {/* Profile Picture */}
        <label style={{ cursor: "pointer", display: "inline-block", marginBottom: 16 }}>
          <input type="file" accept="image/*" onChange={handlePicChange} style={{ display: "none" }} />
          {profilePicPreview ? (
            <img src={profilePicPreview} alt="" style={{
              width: 64, height: 64, borderRadius: "50%", objectFit: "cover",
              border: "3px solid #CC0000",
            }} />
          ) : (
            <div style={{
              width: 64, height: 64, borderRadius: "50%", background: "#1a1a2e",
              border: "2px dashed #2a2a3e", display: "flex", alignItems: "center",
              justifyContent: "center", flexDirection: "column", gap: 2,
            }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
              <span style={{ fontSize: 8, color: "#555" }}>Add Photo</span>
            </div>
          )}
          <div style={{ fontSize: 9, color: "#444", marginTop: 4 }}>Click to change — optional</div>
        </label>

        <input type="text" value={username} onChange={(e) => setUsername(e.target.value.slice(0, 20))}
          placeholder="Choose a username" maxLength={20}
          style={{
            width: "100%", background: "#0a0a16", border: "1px solid #2a2a3e", borderRadius: 8,
            padding: "10px 14px", color: "#ccc", fontSize: 13, outline: "none",
            boxSizing: "border-box", marginBottom: 12, textAlign: "center",
          }}
          onFocus={(e) => (e.target.style.borderColor = "#CC000066")}
          onBlur={(e) => (e.target.style.borderColor = "#2a2a3e")}
          onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
        />

        {error && (
          <div style={{ background: "#CC000015", border: "1px solid #CC000044", borderRadius: 8, padding: "8px 12px", marginBottom: 12, fontSize: 11, color: "#CC0000" }}>
            {error}
          </div>
        )}

        <button onClick={handleSave} disabled={saving} style={{
          width: "100%", background: "#CC0000", border: "none", borderRadius: 8,
          padding: "12px", color: "#fff", fontSize: 14, fontWeight: 700,
          cursor: saving ? "wait" : "pointer",
        }}>
          {saving ? "Saving..." : "Continue"}
        </button>
      </div>
    </div>
  );
}

// --- Team Configuration ---
// ESPN team IDs and API paths for each Utah team

const TEAMS_CONFIG = [
  {
    id: "mammoth",
    name: "Utah Mammoth",
    shortName: "Mammoth",
    logo: "https://a.espncdn.com/i/teamlogos/nhl/500/uta.png",
    accent: "#6CACE4",
    league: "NHL",
    leagueTag: "NHL",
    conference: "Central Division",
    espnUrl: "https://www.espn.com/nhl/team/_/name/utah/utah-mammoth",
    ticketUrl: "https://www.ticketmaster.com/utah-mammoth-tickets/artist/3170222",
    venue: "Delta Center",
    // ESPN API paths (proxied through /api/espn?path=...)
    apiTeam: "sports/hockey/nhl/teams/uta",
    apiSchedule: "sports/hockey/nhl/teams/uta/schedule",
    apiStandings: "sports/hockey/nhl/standings",
    apiRoster: "sports/hockey/nhl/teams/uta/roster",
    teamId: "uta",
    espnAbbr: "UTAH",
    sport: "hockey",
    isHockey: true,
    showPlayoffOdds: false,
    hasSalary: true,
    salaryCap: "$88M",
  },
  {
    id: "jazz",
    name: "Utah Jazz",
    shortName: "Jazz",
    logo: "https://a.espncdn.com/i/teamlogos/nba/500/utah.png",
    accent: "#6B3FA0",
    league: "NBA",
    leagueTag: "NBA",
    conference: "Western Conference",
    espnUrl: "https://www.espn.com/nba/team/_/name/utah/utah-jazz",
    ticketUrl: "https://www.nba.com/jazz/tickets",
    venue: "Delta Center",
    apiTeam: "sports/basketball/nba/teams/26",
    apiSchedule: "sports/basketball/nba/teams/26/schedule",
    apiStandings: "sports/basketball/nba/standings",
    apiRoster: "sports/basketball/nba/teams/26/roster",
    teamId: "26",
    espnAbbr: "UTAH",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: true,
    salaryCap: "$140.6M",
  },
  {
    id: "utes-football",
    name: "Utah Utes Football",
    shortName: "Utes FB",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/254.png",
    accent: "#CC0000",
    league: "NCAA",
    leagueTag: "NCAAF",
    conference: "Big 12 Conference",
    espnUrl: "https://www.espn.com/college-football/team/_/id/254/utah-utes",
    ticketUrl: "https://utahutes.com/sports/football/schedule",
    venue: "Rice-Eccles Stadium",
    apiTeam: "sports/football/college-football/teams/254",
    apiSchedule: "sports/football/college-football/teams/254/schedule",
    apiStandings: "sports/football/college-football/standings",
    apiRoster: "sports/football/college-football/teams/254/roster",
    teamId: "254",
    espnAbbr: "UTAH",
    sport: "football",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
  },
  {
    id: "utes-basketball",
    name: "Utah Utes Basketball",
    shortName: "Utes BBall",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/254.png",
    accent: "#CC0000",
    league: "NCAA",
    leagueTag: "NCAAM",
    conference: "Big 12 Conference",
    espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/254/utah-utes",
    ticketUrl: "https://utahutes.com/sports/mens-basketball/schedule",
    venue: "Jon M. Huntsman Center",
    apiTeam: "sports/basketball/mens-college-basketball/teams/254",
    apiSchedule: "sports/basketball/mens-college-basketball/teams/254/schedule",
    apiStandings: "sports/basketball/mens-college-basketball/standings",
    apiRoster: "sports/basketball/mens-college-basketball/teams/254/roster",
    teamId: "254",
    espnAbbr: "UTAH",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
  },
  // --- BYU Teams ---
  {
    id: "byu-football",
    name: "BYU Cougars Football",
    shortName: "BYU FB",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/252.png",
    accent: "#5B9BD5",
    league: "NCAA",
    leagueTag: "NCAAF",
    conference: "Big 12 Conference",
    espnUrl: "https://www.espn.com/college-football/team/_/id/252/byu-cougars",
    ticketUrl: "https://byucougars.com/sports/football/schedule",
    venue: "LaVell Edwards Stadium",
    apiTeam: "sports/football/college-football/teams/252",
    apiSchedule: "sports/football/college-football/teams/252/schedule",
    apiStandings: "sports/football/college-football/standings",
    apiRoster: "sports/football/college-football/teams/252/roster",
    teamId: "252",
    espnAbbr: "BYU",
    sport: "football",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
    logoBgLight: true,
  },
  {
    id: "byu-basketball",
    name: "BYU Cougars Basketball",
    shortName: "BYU BBall",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/252.png",
    accent: "#5B9BD5",
    league: "NCAA",
    leagueTag: "NCAAM",
    conference: "Big 12 Conference",
    espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/252/byu-cougars",
    ticketUrl: "https://byucougars.com/sports/mens-basketball/schedule",
    venue: "Marriott Center",
    apiTeam: "sports/basketball/mens-college-basketball/teams/252",
    apiSchedule: "sports/basketball/mens-college-basketball/teams/252/schedule",
    apiStandings: "sports/basketball/mens-college-basketball/standings",
    apiRoster: "sports/basketball/mens-college-basketball/teams/252/roster",
    teamId: "252",
    espnAbbr: "BYU",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
    logoBgLight: true,
  },
  // --- Utah State Teams ---
  {
    id: "usu-football",
    name: "Utah State Aggies Football",
    shortName: "USU FB",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/328.png",
    accent: "#4A90D9",
    league: "NCAA",
    leagueTag: "NCAAF",
    conference: "Mountain West Conference",
    espnUrl: "https://www.espn.com/college-football/team/_/id/328/utah-state-aggies",
    ticketUrl: "https://utahstateaggies.com/sports/football/schedule",
    venue: "Maverik Stadium",
    apiTeam: "sports/football/college-football/teams/328",
    apiSchedule: "sports/football/college-football/teams/328/schedule",
    apiStandings: "sports/football/college-football/standings",
    apiRoster: "sports/football/college-football/teams/328/roster",
    teamId: "328",
    espnAbbr: "USU",
    sport: "football",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
    logoBgLight: true,
  },
  {
    id: "usu-basketball",
    name: "Utah State Aggies Basketball",
    shortName: "USU BBall",
    logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/328.png",
    accent: "#4A90D9",
    league: "NCAA",
    leagueTag: "NCAAM",
    conference: "Mountain West Conference",
    espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/328/utah-state-aggies",
    ticketUrl: "https://utahstateaggies.com/sports/mens-basketball/schedule",
    venue: "Dee Glen Smith Spectrum",
    apiTeam: "sports/basketball/mens-college-basketball/teams/328",
    apiSchedule: "sports/basketball/mens-college-basketball/teams/328/schedule",
    apiStandings: "sports/basketball/mens-college-basketball/standings",
    apiRoster: "sports/basketball/mens-college-basketball/teams/328/roster",
    teamId: "328",
    espnAbbr: "USU",
    sport: "basketball",
    isHockey: false,
    showPlayoffOdds: false,
    hasSalary: false,
    salaryCap: null,
    logoBgLight: true,
  },
  // --- MLB Teams ---
  { id: "mlb-ari", name: "Arizona Diamondbacks", shortName: "D-backs", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/ari.png", accent: "#A71930", league: "MLB", leagueTag: "MLB", conference: "NL West", espnUrl: "https://www.espn.com/mlb/team/_/name/ari/arizona-diamondbacks", ticketUrl: "https://www.mlb.com/diamondbacks/tickets", venue: "Chase Field", apiTeam: "sports/baseball/mlb/teams/29", apiSchedule: "sports/baseball/mlb/teams/29/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/29/roster", teamId: "29", espnAbbr: "ARI", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-ath", name: "Athletics", shortName: "Athletics", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/ath.png", accent: "#003831", league: "MLB", leagueTag: "MLB", conference: "AL West", espnUrl: "https://www.espn.com/mlb/team/_/name/ath/athletics", ticketUrl: "https://www.mlb.com/athletics/tickets", venue: "Sutter Health Park", apiTeam: "sports/baseball/mlb/teams/11", apiSchedule: "sports/baseball/mlb/teams/11/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/11/roster", teamId: "11", espnAbbr: "ATH", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-atl", name: "Atlanta Braves", shortName: "Braves", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/atl.png", accent: "#CE1141", league: "MLB", leagueTag: "MLB", conference: "NL East", espnUrl: "https://www.espn.com/mlb/team/_/name/atl/atlanta-braves", ticketUrl: "https://www.mlb.com/braves/tickets", venue: "Truist Park", apiTeam: "sports/baseball/mlb/teams/15", apiSchedule: "sports/baseball/mlb/teams/15/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/15/roster", teamId: "15", espnAbbr: "ATL", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-bal", name: "Baltimore Orioles", shortName: "Orioles", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/bal.png", accent: "#DF4601", league: "MLB", leagueTag: "MLB", conference: "AL East", espnUrl: "https://www.espn.com/mlb/team/_/name/bal/baltimore-orioles", ticketUrl: "https://www.mlb.com/orioles/tickets", venue: "Oriole Park at Camden Yards", apiTeam: "sports/baseball/mlb/teams/1", apiSchedule: "sports/baseball/mlb/teams/1/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/1/roster", teamId: "1", espnAbbr: "BAL", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-bos", name: "Boston Red Sox", shortName: "Red Sox", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/bos.png", accent: "#BD3039", league: "MLB", leagueTag: "MLB", conference: "AL East", espnUrl: "https://www.espn.com/mlb/team/_/name/bos/boston-red-sox", ticketUrl: "https://www.mlb.com/redsox/tickets", venue: "Fenway Park", apiTeam: "sports/baseball/mlb/teams/2", apiSchedule: "sports/baseball/mlb/teams/2/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/2/roster", teamId: "2", espnAbbr: "BOS", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-chc", name: "Chicago Cubs", shortName: "Cubs", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/chc.png", accent: "#0E3386", league: "MLB", leagueTag: "MLB", conference: "NL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/chc/chicago-cubs", ticketUrl: "https://www.mlb.com/cubs/tickets", venue: "Wrigley Field", apiTeam: "sports/baseball/mlb/teams/16", apiSchedule: "sports/baseball/mlb/teams/16/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/16/roster", teamId: "16", espnAbbr: "CHC", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-chw", name: "Chicago White Sox", shortName: "White Sox", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/chw.png", accent: "#27251F", league: "MLB", leagueTag: "MLB", conference: "AL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/chw/chicago-white-sox", ticketUrl: "https://www.mlb.com/whitesox/tickets", venue: "Guaranteed Rate Field", apiTeam: "sports/baseball/mlb/teams/4", apiSchedule: "sports/baseball/mlb/teams/4/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/4/roster", teamId: "4", espnAbbr: "CHW", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-cin", name: "Cincinnati Reds", shortName: "Reds", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/cin.png", accent: "#C6011F", league: "MLB", leagueTag: "MLB", conference: "NL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/cin/cincinnati-reds", ticketUrl: "https://www.mlb.com/reds/tickets", venue: "Great American Ball Park", apiTeam: "sports/baseball/mlb/teams/17", apiSchedule: "sports/baseball/mlb/teams/17/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/17/roster", teamId: "17", espnAbbr: "CIN", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-cle", name: "Cleveland Guardians", shortName: "Guardians", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/cle.png", accent: "#002B5C", league: "MLB", leagueTag: "MLB", conference: "AL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/cle/cleveland-guardians", ticketUrl: "https://www.mlb.com/guardians/tickets", venue: "Progressive Field", apiTeam: "sports/baseball/mlb/teams/5", apiSchedule: "sports/baseball/mlb/teams/5/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/5/roster", teamId: "5", espnAbbr: "CLE", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-col", name: "Colorado Rockies", shortName: "Rockies", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/col.png", accent: "#33006F", league: "MLB", leagueTag: "MLB", conference: "NL West", espnUrl: "https://www.espn.com/mlb/team/_/name/col/colorado-rockies", ticketUrl: "https://www.mlb.com/rockies/tickets", venue: "Coors Field", apiTeam: "sports/baseball/mlb/teams/27", apiSchedule: "sports/baseball/mlb/teams/27/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/27/roster", teamId: "27", espnAbbr: "COL", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-det", name: "Detroit Tigers", shortName: "Tigers", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/det.png", accent: "#0C2340", league: "MLB", leagueTag: "MLB", conference: "AL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/det/detroit-tigers", ticketUrl: "https://www.mlb.com/tigers/tickets", venue: "Comerica Park", apiTeam: "sports/baseball/mlb/teams/6", apiSchedule: "sports/baseball/mlb/teams/6/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/6/roster", teamId: "6", espnAbbr: "DET", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-hou", name: "Houston Astros", shortName: "Astros", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/hou.png", accent: "#EB6E1F", league: "MLB", leagueTag: "MLB", conference: "AL West", espnUrl: "https://www.espn.com/mlb/team/_/name/hou/houston-astros", ticketUrl: "https://www.mlb.com/astros/tickets", venue: "Minute Maid Park", apiTeam: "sports/baseball/mlb/teams/18", apiSchedule: "sports/baseball/mlb/teams/18/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/18/roster", teamId: "18", espnAbbr: "HOU", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-kc", name: "Kansas City Royals", shortName: "Royals", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/kc.png", accent: "#004687", league: "MLB", leagueTag: "MLB", conference: "AL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/kc/kansas-city-royals", ticketUrl: "https://www.mlb.com/royals/tickets", venue: "Kauffman Stadium", apiTeam: "sports/baseball/mlb/teams/7", apiSchedule: "sports/baseball/mlb/teams/7/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/7/roster", teamId: "7", espnAbbr: "KC", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-laa", name: "Los Angeles Angels", shortName: "Angels", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/laa.png", accent: "#BA0021", league: "MLB", leagueTag: "MLB", conference: "AL West", espnUrl: "https://www.espn.com/mlb/team/_/name/laa/los-angeles-angels", ticketUrl: "https://www.mlb.com/angels/tickets", venue: "Angel Stadium", apiTeam: "sports/baseball/mlb/teams/3", apiSchedule: "sports/baseball/mlb/teams/3/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/3/roster", teamId: "3", espnAbbr: "LAA", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-lad", name: "Los Angeles Dodgers", shortName: "Dodgers", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/lad.png", accent: "#005A9C", league: "MLB", leagueTag: "MLB", conference: "NL West", espnUrl: "https://www.espn.com/mlb/team/_/name/lad/los-angeles-dodgers", ticketUrl: "https://www.mlb.com/dodgers/tickets", venue: "Dodger Stadium", apiTeam: "sports/baseball/mlb/teams/19", apiSchedule: "sports/baseball/mlb/teams/19/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/19/roster", teamId: "19", espnAbbr: "LAD", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-mia", name: "Miami Marlins", shortName: "Marlins", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/mia.png", accent: "#00A3E0", league: "MLB", leagueTag: "MLB", conference: "NL East", espnUrl: "https://www.espn.com/mlb/team/_/name/mia/miami-marlins", ticketUrl: "https://www.mlb.com/marlins/tickets", venue: "LoanDepot Park", apiTeam: "sports/baseball/mlb/teams/28", apiSchedule: "sports/baseball/mlb/teams/28/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/28/roster", teamId: "28", espnAbbr: "MIA", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-mil", name: "Milwaukee Brewers", shortName: "Brewers", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/mil.png", accent: "#13294B", league: "MLB", leagueTag: "MLB", conference: "NL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/mil/milwaukee-brewers", ticketUrl: "https://www.mlb.com/brewers/tickets", venue: "American Family Field", apiTeam: "sports/baseball/mlb/teams/8", apiSchedule: "sports/baseball/mlb/teams/8/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/8/roster", teamId: "8", espnAbbr: "MIL", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-min", name: "Minnesota Twins", shortName: "Twins", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/min.png", accent: "#002B5C", league: "MLB", leagueTag: "MLB", conference: "AL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/min/minnesota-twins", ticketUrl: "https://www.mlb.com/twins/tickets", venue: "Target Field", apiTeam: "sports/baseball/mlb/teams/9", apiSchedule: "sports/baseball/mlb/teams/9/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/9/roster", teamId: "9", espnAbbr: "MIN", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-nym", name: "New York Mets", shortName: "Mets", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/nym.png", accent: "#002D72", league: "MLB", leagueTag: "MLB", conference: "NL East", espnUrl: "https://www.espn.com/mlb/team/_/name/nym/new-york-mets", ticketUrl: "https://www.mlb.com/mets/tickets", venue: "Citi Field", apiTeam: "sports/baseball/mlb/teams/21", apiSchedule: "sports/baseball/mlb/teams/21/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/21/roster", teamId: "21", espnAbbr: "NYM", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-nyy", name: "New York Yankees", shortName: "Yankees", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/nyy.png", accent: "#003087", league: "MLB", leagueTag: "MLB", conference: "AL East", espnUrl: "https://www.espn.com/mlb/team/_/name/nyy/new-york-yankees", ticketUrl: "https://www.mlb.com/yankees/tickets", venue: "Yankee Stadium", apiTeam: "sports/baseball/mlb/teams/10", apiSchedule: "sports/baseball/mlb/teams/10/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/10/roster", teamId: "10", espnAbbr: "NYY", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-phi", name: "Philadelphia Phillies", shortName: "Phillies", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/phi.png", accent: "#E81828", league: "MLB", leagueTag: "MLB", conference: "NL East", espnUrl: "https://www.espn.com/mlb/team/_/name/phi/philadelphia-phillies", ticketUrl: "https://www.mlb.com/phillies/tickets", venue: "Citizens Bank Park", apiTeam: "sports/baseball/mlb/teams/22", apiSchedule: "sports/baseball/mlb/teams/22/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/22/roster", teamId: "22", espnAbbr: "PHI", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-pit", name: "Pittsburgh Pirates", shortName: "Pirates", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/pit.png", accent: "#FDB827", league: "MLB", leagueTag: "MLB", conference: "NL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/pit/pittsburgh-pirates", ticketUrl: "https://www.mlb.com/pirates/tickets", venue: "PNC Park", apiTeam: "sports/baseball/mlb/teams/23", apiSchedule: "sports/baseball/mlb/teams/23/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/23/roster", teamId: "23", espnAbbr: "PIT", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-sd", name: "San Diego Padres", shortName: "Padres", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/sd.png", accent: "#2F241D", league: "MLB", leagueTag: "MLB", conference: "NL West", espnUrl: "https://www.espn.com/mlb/team/_/name/sd/san-diego-padres", ticketUrl: "https://www.mlb.com/padres/tickets", venue: "Petco Park", apiTeam: "sports/baseball/mlb/teams/25", apiSchedule: "sports/baseball/mlb/teams/25/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/25/roster", teamId: "25", espnAbbr: "SD", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-sf", name: "San Francisco Giants", shortName: "Giants", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/sf.png", accent: "#FD5A1E", league: "MLB", leagueTag: "MLB", conference: "NL West", espnUrl: "https://www.espn.com/mlb/team/_/name/sf/san-francisco-giants", ticketUrl: "https://www.mlb.com/giants/tickets", venue: "Oracle Park", apiTeam: "sports/baseball/mlb/teams/26", apiSchedule: "sports/baseball/mlb/teams/26/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/26/roster", teamId: "26", espnAbbr: "SF", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-sea", name: "Seattle Mariners", shortName: "Mariners", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/sea.png", accent: "#005C5C", league: "MLB", leagueTag: "MLB", conference: "AL West", espnUrl: "https://www.espn.com/mlb/team/_/name/sea/seattle-mariners", ticketUrl: "https://www.mlb.com/mariners/tickets", venue: "T-Mobile Park", apiTeam: "sports/baseball/mlb/teams/12", apiSchedule: "sports/baseball/mlb/teams/12/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/12/roster", teamId: "12", espnAbbr: "SEA", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-stl", name: "St. Louis Cardinals", shortName: "Cardinals", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/stl.png", accent: "#C41E3A", league: "MLB", leagueTag: "MLB", conference: "NL Central", espnUrl: "https://www.espn.com/mlb/team/_/name/stl/st-louis-cardinals", ticketUrl: "https://www.mlb.com/cardinals/tickets", venue: "Busch Stadium", apiTeam: "sports/baseball/mlb/teams/24", apiSchedule: "sports/baseball/mlb/teams/24/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/24/roster", teamId: "24", espnAbbr: "STL", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-tb", name: "Tampa Bay Rays", shortName: "Rays", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/tb.png", accent: "#092C5C", league: "MLB", leagueTag: "MLB", conference: "AL East", espnUrl: "https://www.espn.com/mlb/team/_/name/tb/tampa-bay-rays", ticketUrl: "https://www.mlb.com/rays/tickets", venue: "Tropicana Field", apiTeam: "sports/baseball/mlb/teams/30", apiSchedule: "sports/baseball/mlb/teams/30/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/30/roster", teamId: "30", espnAbbr: "TB", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-tex", name: "Texas Rangers", shortName: "Rangers", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/tex.png", accent: "#003278", league: "MLB", leagueTag: "MLB", conference: "AL West", espnUrl: "https://www.espn.com/mlb/team/_/name/tex/texas-rangers", ticketUrl: "https://www.mlb.com/rangers/tickets", venue: "Globe Life Field", apiTeam: "sports/baseball/mlb/teams/13", apiSchedule: "sports/baseball/mlb/teams/13/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/13/roster", teamId: "13", espnAbbr: "TEX", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-tor", name: "Toronto Blue Jays", shortName: "Blue Jays", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/tor.png", accent: "#134A8E", league: "MLB", leagueTag: "MLB", conference: "AL East", espnUrl: "https://www.espn.com/mlb/team/_/name/tor/toronto-blue-jays", ticketUrl: "https://www.mlb.com/bluejays/tickets", venue: "Rogers Centre", apiTeam: "sports/baseball/mlb/teams/14", apiSchedule: "sports/baseball/mlb/teams/14/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/14/roster", teamId: "14", espnAbbr: "TOR", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  { id: "mlb-wsh", name: "Washington Nationals", shortName: "Nationals", logo: "https://a.espncdn.com/i/teamlogos/mlb/500/wsh.png", accent: "#AB0003", league: "MLB", leagueTag: "MLB", conference: "NL East", espnUrl: "https://www.espn.com/mlb/team/_/name/wsh/washington-nationals", ticketUrl: "https://www.mlb.com/nationals/tickets", venue: "Nationals Park", apiTeam: "sports/baseball/mlb/teams/20", apiSchedule: "sports/baseball/mlb/teams/20/schedule", apiStandings: "sports/baseball/mlb/standings", apiRoster: "sports/baseball/mlb/teams/20/roster", teamId: "20", espnAbbr: "WSH", sport: "baseball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: null },
  // --- NBA Teams ---
  { id: "nba-atl", name: "Atlanta Hawks", shortName: "Hawks", logo: "https://a.espncdn.com/i/teamlogos/nba/500/1.png", accent: "#c8102e", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/atl/atlanta-hawks", ticketUrl: "https://www.nba.com/atl/atlanta-hawks/tickets", venue: "State Farm Arena", apiTeam: "sports/basketball/nba/teams/1", apiSchedule: "sports/basketball/nba/teams/1/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/1/roster", teamId: "1", espnAbbr: "ATL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-bos", name: "Boston Celtics", shortName: "Celtics", logo: "https://a.espncdn.com/i/teamlogos/nba/500/2.png", accent: "#008348", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/bos/boston-celtics", ticketUrl: "https://www.nba.com/bos/boston-celtics/tickets", venue: "TD Garden", apiTeam: "sports/basketball/nba/teams/2", apiSchedule: "sports/basketball/nba/teams/2/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/2/roster", teamId: "2", espnAbbr: "BOS", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-bkn", name: "Brooklyn Nets", shortName: "Nets", logo: "https://a.espncdn.com/i/teamlogos/nba/500/17.png", accent: "#777777", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/bkn/brooklyn-nets", ticketUrl: "https://www.nba.com/bkn/brooklyn-nets/tickets", venue: "Barclays Center", apiTeam: "sports/basketball/nba/teams/17", apiSchedule: "sports/basketball/nba/teams/17/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/17/roster", teamId: "17", espnAbbr: "BKN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-cha", name: "Charlotte Hornets", shortName: "Hornets", logo: "https://a.espncdn.com/i/teamlogos/nba/500/30.png", accent: "#008ca8", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/cha/charlotte-hornets", ticketUrl: "https://www.nba.com/cha/charlotte-hornets/tickets", venue: "Spectrum Center", apiTeam: "sports/basketball/nba/teams/30", apiSchedule: "sports/basketball/nba/teams/30/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/30/roster", teamId: "30", espnAbbr: "CHA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-chi", name: "Chicago Bulls", shortName: "Bulls", logo: "https://a.espncdn.com/i/teamlogos/nba/500/4.png", accent: "#ce1141", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/chi/chicago-bulls", ticketUrl: "https://www.nba.com/chi/chicago-bulls/tickets", venue: "United Center", apiTeam: "sports/basketball/nba/teams/4", apiSchedule: "sports/basketball/nba/teams/4/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/4/roster", teamId: "4", espnAbbr: "CHI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-cle", name: "Cleveland Cavaliers", shortName: "Cavaliers", logo: "https://a.espncdn.com/i/teamlogos/nba/500/5.png", accent: "#860038", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/cle/cleveland-cavaliers", ticketUrl: "https://www.nba.com/cle/cleveland-cavaliers/tickets", venue: "Rocket Mortgage FieldHouse", apiTeam: "sports/basketball/nba/teams/5", apiSchedule: "sports/basketball/nba/teams/5/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/5/roster", teamId: "5", espnAbbr: "CLE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-dal", name: "Dallas Mavericks", shortName: "Mavericks", logo: "https://a.espncdn.com/i/teamlogos/nba/500/6.png", accent: "#0064b1", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/dal/dallas-mavericks", ticketUrl: "https://www.nba.com/dal/dallas-mavericks/tickets", venue: "American Airlines Center", apiTeam: "sports/basketball/nba/teams/6", apiSchedule: "sports/basketball/nba/teams/6/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/6/roster", teamId: "6", espnAbbr: "DAL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-den", name: "Denver Nuggets", shortName: "Nuggets", logo: "https://a.espncdn.com/i/teamlogos/nba/500/7.png", accent: "#1D428A", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/den/denver-nuggets", ticketUrl: "https://www.nba.com/den/denver-nuggets/tickets", venue: "Ball Arena", apiTeam: "sports/basketball/nba/teams/7", apiSchedule: "sports/basketball/nba/teams/7/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/7/roster", teamId: "7", espnAbbr: "DEN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-det", name: "Detroit Pistons", shortName: "Pistons", logo: "https://a.espncdn.com/i/teamlogos/nba/500/8.png", accent: "#1d428a", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/det/detroit-pistons", ticketUrl: "https://www.nba.com/det/detroit-pistons/tickets", venue: "Little Caesars Arena", apiTeam: "sports/basketball/nba/teams/8", apiSchedule: "sports/basketball/nba/teams/8/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/8/roster", teamId: "8", espnAbbr: "DET", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-gs", name: "Golden State Warriors", shortName: "Warriors", logo: "https://a.espncdn.com/i/teamlogos/nba/500/9.png", accent: "#fdb927", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/gs/golden-state-warriors", ticketUrl: "https://www.nba.com/gs/golden-state-warriors/tickets", venue: "Chase Center", apiTeam: "sports/basketball/nba/teams/9", apiSchedule: "sports/basketball/nba/teams/9/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/9/roster", teamId: "9", espnAbbr: "GS", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-hou", name: "Houston Rockets", shortName: "Rockets", logo: "https://a.espncdn.com/i/teamlogos/nba/500/10.png", accent: "#ce1141", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/hou/houston-rockets", ticketUrl: "https://www.nba.com/hou/houston-rockets/tickets", venue: "Toyota Center", apiTeam: "sports/basketball/nba/teams/10", apiSchedule: "sports/basketball/nba/teams/10/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/10/roster", teamId: "10", espnAbbr: "HOU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-ind", name: "Indiana Pacers", shortName: "Pacers", logo: "https://a.espncdn.com/i/teamlogos/nba/500/11.png", accent: "#002D62", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/ind/indiana-pacers", ticketUrl: "https://www.nba.com/ind/indiana-pacers/tickets", venue: "Gainbridge Fieldhouse", apiTeam: "sports/basketball/nba/teams/11", apiSchedule: "sports/basketball/nba/teams/11/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/11/roster", teamId: "11", espnAbbr: "IND", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-lac", name: "LA Clippers", shortName: "Clippers", logo: "https://a.espncdn.com/i/teamlogos/nba/500/12.png", accent: "#C8102E", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/lac/la-clippers", ticketUrl: "https://www.nba.com/lac/la-clippers/tickets", venue: "Intuit Dome", apiTeam: "sports/basketball/nba/teams/12", apiSchedule: "sports/basketball/nba/teams/12/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/12/roster", teamId: "12", espnAbbr: "LAC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-lal", name: "Los Angeles Lakers", shortName: "Lakers", logo: "https://a.espncdn.com/i/teamlogos/nba/500/13.png", accent: "#552583", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/lal/los-angeles-lakers", ticketUrl: "https://www.nba.com/lal/los-angeles-lakers/tickets", venue: "Crypto.com Arena", apiTeam: "sports/basketball/nba/teams/13", apiSchedule: "sports/basketball/nba/teams/13/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/13/roster", teamId: "13", espnAbbr: "LAL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-mem", name: "Memphis Grizzlies", shortName: "Grizzlies", logo: "https://a.espncdn.com/i/teamlogos/nba/500/29.png", accent: "#5d76a9", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/mem/memphis-grizzlies", ticketUrl: "https://www.nba.com/mem/memphis-grizzlies/tickets", venue: "FedExForum", apiTeam: "sports/basketball/nba/teams/29", apiSchedule: "sports/basketball/nba/teams/29/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/29/roster", teamId: "29", espnAbbr: "MEM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-mia", name: "Miami Heat", shortName: "Heat", logo: "https://a.espncdn.com/i/teamlogos/nba/500/14.png", accent: "#98002e", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/mia/miami-heat", ticketUrl: "https://www.nba.com/mia/miami-heat/tickets", venue: "Kaseya Center", apiTeam: "sports/basketball/nba/teams/14", apiSchedule: "sports/basketball/nba/teams/14/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/14/roster", teamId: "14", espnAbbr: "MIA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-mil", name: "Milwaukee Bucks", shortName: "Bucks", logo: "https://a.espncdn.com/i/teamlogos/nba/500/15.png", accent: "#00471b", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/mil/milwaukee-bucks", ticketUrl: "https://www.nba.com/mil/milwaukee-bucks/tickets", venue: "Fiserv Forum", apiTeam: "sports/basketball/nba/teams/15", apiSchedule: "sports/basketball/nba/teams/15/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/15/roster", teamId: "15", espnAbbr: "MIL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-min", name: "Minnesota Timberwolves", shortName: "Timberwolves", logo: "https://a.espncdn.com/i/teamlogos/nba/500/16.png", accent: "#266092", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/min/minnesota-timberwolves", ticketUrl: "https://www.nba.com/min/minnesota-timberwolves/tickets", venue: "Target Center", apiTeam: "sports/basketball/nba/teams/16", apiSchedule: "sports/basketball/nba/teams/16/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/16/roster", teamId: "16", espnAbbr: "MIN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-no", name: "New Orleans Pelicans", shortName: "Pelicans", logo: "https://a.espncdn.com/i/teamlogos/nba/500/3.png", accent: "#002B5C", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/no/new-orleans-pelicans", ticketUrl: "https://www.nba.com/no/new-orleans-pelicans/tickets", venue: "Smoothie King Center", apiTeam: "sports/basketball/nba/teams/3", apiSchedule: "sports/basketball/nba/teams/3/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/3/roster", teamId: "3", espnAbbr: "NO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-ny", name: "New York Knicks", shortName: "Knicks", logo: "https://a.espncdn.com/i/teamlogos/nba/500/18.png", accent: "#F58426", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/ny/new-york-knicks", ticketUrl: "https://www.nba.com/ny/new-york-knicks/tickets", venue: "Madison Square Garden", apiTeam: "sports/basketball/nba/teams/18", apiSchedule: "sports/basketball/nba/teams/18/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/18/roster", teamId: "18", espnAbbr: "NY", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-okc", name: "Oklahoma City Thunder", shortName: "Thunder", logo: "https://a.espncdn.com/i/teamlogos/nba/500/25.png", accent: "#007ac1", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/okc/oklahoma-city-thunder", ticketUrl: "https://www.nba.com/okc/oklahoma-city-thunder/tickets", venue: "Paycom Center", apiTeam: "sports/basketball/nba/teams/25", apiSchedule: "sports/basketball/nba/teams/25/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/25/roster", teamId: "25", espnAbbr: "OKC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-orl", name: "Orlando Magic", shortName: "Magic", logo: "https://a.espncdn.com/i/teamlogos/nba/500/19.png", accent: "#0150b5", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/orl/orlando-magic", ticketUrl: "https://www.nba.com/orl/orlando-magic/tickets", venue: "Kia Center", apiTeam: "sports/basketball/nba/teams/19", apiSchedule: "sports/basketball/nba/teams/19/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/19/roster", teamId: "19", espnAbbr: "ORL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-phi", name: "Philadelphia 76ers", shortName: "76ers", logo: "https://a.espncdn.com/i/teamlogos/nba/500/20.png", accent: "#1d428a", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/phi/philadelphia-76ers", ticketUrl: "https://www.nba.com/phi/philadelphia-76ers/tickets", venue: "Wells Fargo Center", apiTeam: "sports/basketball/nba/teams/20", apiSchedule: "sports/basketball/nba/teams/20/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/20/roster", teamId: "20", espnAbbr: "PHI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-phx", name: "Phoenix Suns", shortName: "Suns", logo: "https://a.espncdn.com/i/teamlogos/nba/500/21.png", accent: "#29127a", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/phx/phoenix-suns", ticketUrl: "https://www.nba.com/phx/phoenix-suns/tickets", venue: "Footprint Center", apiTeam: "sports/basketball/nba/teams/21", apiSchedule: "sports/basketball/nba/teams/21/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/21/roster", teamId: "21", espnAbbr: "PHX", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-por", name: "Portland Trail Blazers", shortName: "Trail Blazers", logo: "https://a.espncdn.com/i/teamlogos/nba/500/22.png", accent: "#e03a3e", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/por/portland-trail-blazers", ticketUrl: "https://www.nba.com/por/portland-trail-blazers/tickets", venue: "Moda Center", apiTeam: "sports/basketball/nba/teams/22", apiSchedule: "sports/basketball/nba/teams/22/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/22/roster", teamId: "22", espnAbbr: "POR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-sac", name: "Sacramento Kings", shortName: "Kings", logo: "https://a.espncdn.com/i/teamlogos/nba/500/23.png", accent: "#5a2d81", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/sac/sacramento-kings", ticketUrl: "https://www.nba.com/sac/sacramento-kings/tickets", venue: "Golden 1 Center", apiTeam: "sports/basketball/nba/teams/23", apiSchedule: "sports/basketball/nba/teams/23/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/23/roster", teamId: "23", espnAbbr: "SAC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-sa", name: "San Antonio Spurs", shortName: "Spurs", logo: "https://a.espncdn.com/i/teamlogos/nba/500/24.png", accent: "#8A8D8F", league: "NBA", leagueTag: "NBA", conference: "Western Conference", espnUrl: "https://www.espn.com/nba/team/_/name/sa/san-antonio-spurs", ticketUrl: "https://www.nba.com/sa/san-antonio-spurs/tickets", venue: "Frost Bank Center", apiTeam: "sports/basketball/nba/teams/24", apiSchedule: "sports/basketball/nba/teams/24/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/24/roster", teamId: "24", espnAbbr: "SA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-tor", name: "Toronto Raptors", shortName: "Raptors", logo: "https://a.espncdn.com/i/teamlogos/nba/500/28.png", accent: "#d91244", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/tor/toronto-raptors", ticketUrl: "https://www.nba.com/tor/toronto-raptors/tickets", venue: "Scotiabank Arena", apiTeam: "sports/basketball/nba/teams/28", apiSchedule: "sports/basketball/nba/teams/28/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/28/roster", teamId: "28", espnAbbr: "TOR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  { id: "nba-wsh", name: "Washington Wizards", shortName: "Wizards", logo: "https://a.espncdn.com/i/teamlogos/nba/500/27.png", accent: "#e31837", league: "NBA", leagueTag: "NBA", conference: "Eastern Conference", espnUrl: "https://www.espn.com/nba/team/_/name/wsh/washington-wizards", ticketUrl: "https://www.nba.com/wsh/washington-wizards/tickets", venue: "Capital One Arena", apiTeam: "sports/basketball/nba/teams/27", apiSchedule: "sports/basketball/nba/teams/27/schedule", apiStandings: "sports/basketball/nba/standings", apiRoster: "sports/basketball/nba/teams/27/roster", teamId: "27", espnAbbr: "WSH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$140.6M" },
  // --- NHL Teams ---
  { id: "nhl-ana", name: "Anaheim Ducks", shortName: "Ducks", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/ana.png", accent: "#fc4c02", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/ana/anaheim-ducks", ticketUrl: "https://www.nhl.com/ana/anaheim-ducks/tickets", venue: "Honda Center", apiTeam: "sports/hockey/nhl/teams/25", apiSchedule: "sports/hockey/nhl/teams/25/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/25/roster", teamId: "25", espnAbbr: "ANA", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-bos", name: "Boston Bruins", shortName: "Bruins", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/bos.png", accent: "#FFB81C", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/bos/boston-bruins", ticketUrl: "https://www.nhl.com/bos/boston-bruins/tickets", venue: "TD Garden", apiTeam: "sports/hockey/nhl/teams/1", apiSchedule: "sports/hockey/nhl/teams/1/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/1/roster", teamId: "1", espnAbbr: "BOS", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-buf", name: "Buffalo Sabres", shortName: "Sabres", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/buf.png", accent: "#00468b", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/buf/buffalo-sabres", ticketUrl: "https://www.nhl.com/buf/buffalo-sabres/tickets", venue: "KeyBank Center", apiTeam: "sports/hockey/nhl/teams/2", apiSchedule: "sports/hockey/nhl/teams/2/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/2/roster", teamId: "2", espnAbbr: "BUF", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-cgy", name: "Calgary Flames", shortName: "Flames", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/cgy.png", accent: "#dd1a32", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/cgy/calgary-flames", ticketUrl: "https://www.nhl.com/cgy/calgary-flames/tickets", venue: "Scotiabank Saddledome", apiTeam: "sports/hockey/nhl/teams/3", apiSchedule: "sports/hockey/nhl/teams/3/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/3/roster", teamId: "3", espnAbbr: "CGY", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-car", name: "Carolina Hurricanes", shortName: "Hurricanes", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/car.png", accent: "#e30426", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/car/carolina-hurricanes", ticketUrl: "https://www.nhl.com/car/carolina-hurricanes/tickets", venue: "PNC Arena", apiTeam: "sports/hockey/nhl/teams/7", apiSchedule: "sports/hockey/nhl/teams/7/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/7/roster", teamId: "7", espnAbbr: "CAR", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-chi", name: "Chicago Blackhawks", shortName: "Blackhawks", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/chi.png", accent: "#e31937", league: "NHL", leagueTag: "NHL", conference: "Central Division", espnUrl: "https://www.espn.com/nhl/team/_/name/chi/chicago-blackhawks", ticketUrl: "https://www.nhl.com/chi/chicago-blackhawks/tickets", venue: "United Center", apiTeam: "sports/hockey/nhl/teams/4", apiSchedule: "sports/hockey/nhl/teams/4/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/4/roster", teamId: "4", espnAbbr: "CHI", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-col", name: "Colorado Avalanche", shortName: "Avalanche", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/col.png", accent: "#860038", league: "NHL", leagueTag: "NHL", conference: "Central Division", espnUrl: "https://www.espn.com/nhl/team/_/name/col/colorado-avalanche", ticketUrl: "https://www.nhl.com/col/colorado-avalanche/tickets", venue: "Ball Arena", apiTeam: "sports/hockey/nhl/teams/17", apiSchedule: "sports/hockey/nhl/teams/17/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/17/roster", teamId: "17", espnAbbr: "COL", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-cbj", name: "Columbus Blue Jackets", shortName: "Blue Jackets", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/cbj.png", accent: "#002d62", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/cbj/columbus-blue-jackets", ticketUrl: "https://www.nhl.com/cbj/columbus-blue-jackets/tickets", venue: "Nationwide Arena", apiTeam: "sports/hockey/nhl/teams/29", apiSchedule: "sports/hockey/nhl/teams/29/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/29/roster", teamId: "29", espnAbbr: "CBJ", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-dal", name: "Dallas Stars", shortName: "Stars", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/dal.png", accent: "#20864c", league: "NHL", leagueTag: "NHL", conference: "Central Division", espnUrl: "https://www.espn.com/nhl/team/_/name/dal/dallas-stars", ticketUrl: "https://www.nhl.com/dal/dallas-stars/tickets", venue: "American Airlines Center", apiTeam: "sports/hockey/nhl/teams/9", apiSchedule: "sports/hockey/nhl/teams/9/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/9/roster", teamId: "9", espnAbbr: "DAL", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-det", name: "Detroit Red Wings", shortName: "Red Wings", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/det.png", accent: "#e30526", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/det/detroit-red-wings", ticketUrl: "https://www.nhl.com/det/detroit-red-wings/tickets", venue: "Little Caesars Arena", apiTeam: "sports/hockey/nhl/teams/5", apiSchedule: "sports/hockey/nhl/teams/5/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/5/roster", teamId: "5", espnAbbr: "DET", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-edm", name: "Edmonton Oilers", shortName: "Oilers", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/edm.png", accent: "#00205b", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/edm/edmonton-oilers", ticketUrl: "https://www.nhl.com/edm/edmonton-oilers/tickets", venue: "Rogers Place", apiTeam: "sports/hockey/nhl/teams/6", apiSchedule: "sports/hockey/nhl/teams/6/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/6/roster", teamId: "6", espnAbbr: "EDM", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-fla", name: "Florida Panthers", shortName: "Panthers", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/fla.png", accent: "#e51937", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/fla/florida-panthers", ticketUrl: "https://www.nhl.com/fla/florida-panthers/tickets", venue: "Amerant Bank Arena", apiTeam: "sports/hockey/nhl/teams/26", apiSchedule: "sports/hockey/nhl/teams/26/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/26/roster", teamId: "26", espnAbbr: "FLA", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-la", name: "Los Angeles Kings", shortName: "Kings", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/la.png", accent: "#A2AAAD", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/la/los-angeles-kings", ticketUrl: "https://www.nhl.com/la/los-angeles-kings/tickets", venue: "Crypto.com Arena", apiTeam: "sports/hockey/nhl/teams/8", apiSchedule: "sports/hockey/nhl/teams/8/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/8/roster", teamId: "8", espnAbbr: "LA", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-min", name: "Minnesota Wild", shortName: "Wild", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/min.png", accent: "#124734", league: "NHL", leagueTag: "NHL", conference: "Central Division", espnUrl: "https://www.espn.com/nhl/team/_/name/min/minnesota-wild", ticketUrl: "https://www.nhl.com/min/minnesota-wild/tickets", venue: "Xcel Energy Center", apiTeam: "sports/hockey/nhl/teams/30", apiSchedule: "sports/hockey/nhl/teams/30/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/30/roster", teamId: "30", espnAbbr: "MIN", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-mtl", name: "Montreal Canadiens", shortName: "Canadiens", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/mtl.png", accent: "#c41230", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/mtl/montreal-canadiens", ticketUrl: "https://www.nhl.com/mtl/montreal-canadiens/tickets", venue: "Bell Centre", apiTeam: "sports/hockey/nhl/teams/10", apiSchedule: "sports/hockey/nhl/teams/10/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/10/roster", teamId: "10", espnAbbr: "MTL", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-nsh", name: "Nashville Predators", shortName: "Predators", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/nsh.png", accent: "#fdba31", league: "NHL", leagueTag: "NHL", conference: "Central Division", espnUrl: "https://www.espn.com/nhl/team/_/name/nsh/nashville-predators", ticketUrl: "https://www.nhl.com/nsh/nashville-predators/tickets", venue: "Bridgestone Arena", apiTeam: "sports/hockey/nhl/teams/27", apiSchedule: "sports/hockey/nhl/teams/27/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/27/roster", teamId: "27", espnAbbr: "NSH", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-nj", name: "New Jersey Devils", shortName: "Devils", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/nj.png", accent: "#e30b2b", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/nj/new-jersey-devils", ticketUrl: "https://www.nhl.com/nj/new-jersey-devils/tickets", venue: "Prudential Center", apiTeam: "sports/hockey/nhl/teams/11", apiSchedule: "sports/hockey/nhl/teams/11/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/11/roster", teamId: "11", espnAbbr: "NJ", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-nyi", name: "New York Islanders", shortName: "Islanders", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/nyi.png", accent: "#00529b", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/nyi/new-york-islanders", ticketUrl: "https://www.nhl.com/nyi/new-york-islanders/tickets", venue: "UBS Arena", apiTeam: "sports/hockey/nhl/teams/12", apiSchedule: "sports/hockey/nhl/teams/12/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/12/roster", teamId: "12", espnAbbr: "NYI", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-nyr", name: "New York Rangers", shortName: "Rangers", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/nyr.png", accent: "#0056ae", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/nyr/new-york-rangers", ticketUrl: "https://www.nhl.com/nyr/new-york-rangers/tickets", venue: "Madison Square Garden", apiTeam: "sports/hockey/nhl/teams/13", apiSchedule: "sports/hockey/nhl/teams/13/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/13/roster", teamId: "13", espnAbbr: "NYR", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-ott", name: "Ottawa Senators", shortName: "Senators", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/ott.png", accent: "#dd1a32", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/ott/ottawa-senators", ticketUrl: "https://www.nhl.com/ott/ottawa-senators/tickets", venue: "Canadian Tire Centre", apiTeam: "sports/hockey/nhl/teams/14", apiSchedule: "sports/hockey/nhl/teams/14/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/14/roster", teamId: "14", espnAbbr: "OTT", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-phi", name: "Philadelphia Flyers", shortName: "Flyers", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/phi.png", accent: "#fe5823", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/phi/philadelphia-flyers", ticketUrl: "https://www.nhl.com/phi/philadelphia-flyers/tickets", venue: "Wells Fargo Center", apiTeam: "sports/hockey/nhl/teams/15", apiSchedule: "sports/hockey/nhl/teams/15/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/15/roster", teamId: "15", espnAbbr: "PHI", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-pit", name: "Pittsburgh Penguins", shortName: "Penguins", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/pit.png", accent: "#FCB514", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/pit/pittsburgh-penguins", ticketUrl: "https://www.nhl.com/pit/pittsburgh-penguins/tickets", venue: "PPG Paints Arena", apiTeam: "sports/hockey/nhl/teams/16", apiSchedule: "sports/hockey/nhl/teams/16/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/16/roster", teamId: "16", espnAbbr: "PIT", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-sj", name: "San Jose Sharks", shortName: "Sharks", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/sj.png", accent: "#00788a", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/sj/san-jose-sharks", ticketUrl: "https://www.nhl.com/sj/san-jose-sharks/tickets", venue: "SAP Center", apiTeam: "sports/hockey/nhl/teams/18", apiSchedule: "sports/hockey/nhl/teams/18/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/18/roster", teamId: "18", espnAbbr: "SJ", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-sea", name: "Seattle Kraken", shortName: "Kraken", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/sea.png", accent: "#68A2B9", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/sea/seattle-kraken", ticketUrl: "https://www.nhl.com/sea/seattle-kraken/tickets", venue: "Climate Pledge Arena", apiTeam: "sports/hockey/nhl/teams/124292", apiSchedule: "sports/hockey/nhl/teams/124292/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/124292/roster", teamId: "124292", espnAbbr: "SEA", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-stl", name: "St. Louis Blues", shortName: "Blues", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/stl.png", accent: "#0070b9", league: "NHL", leagueTag: "NHL", conference: "Central Division", espnUrl: "https://www.espn.com/nhl/team/_/name/stl/st-louis-blues", ticketUrl: "https://www.nhl.com/stl/st-louis-blues/tickets", venue: "Enterprise Center", apiTeam: "sports/hockey/nhl/teams/19", apiSchedule: "sports/hockey/nhl/teams/19/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/19/roster", teamId: "19", espnAbbr: "STL", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-tb", name: "Tampa Bay Lightning", shortName: "Lightning", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/tb.png", accent: "#003e7e", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/tb/tampa-bay-lightning", ticketUrl: "https://www.nhl.com/tb/tampa-bay-lightning/tickets", venue: "Amalie Arena", apiTeam: "sports/hockey/nhl/teams/20", apiSchedule: "sports/hockey/nhl/teams/20/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/20/roster", teamId: "20", espnAbbr: "TB", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-tor", name: "Toronto Maple Leafs", shortName: "Maple Leafs", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/tor.png", accent: "#003e7e", league: "NHL", leagueTag: "NHL", conference: "Atlantic Division", espnUrl: "https://www.espn.com/nhl/team/_/name/tor/toronto-maple-leafs", ticketUrl: "https://www.nhl.com/tor/toronto-maple-leafs/tickets", venue: "Scotiabank Arena", apiTeam: "sports/hockey/nhl/teams/21", apiSchedule: "sports/hockey/nhl/teams/21/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/21/roster", teamId: "21", espnAbbr: "TOR", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-van", name: "Vancouver Canucks", shortName: "Canucks", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/van.png", accent: "#003e7e", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/van/vancouver-canucks", ticketUrl: "https://www.nhl.com/van/vancouver-canucks/tickets", venue: "Rogers Arena", apiTeam: "sports/hockey/nhl/teams/22", apiSchedule: "sports/hockey/nhl/teams/22/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/22/roster", teamId: "22", espnAbbr: "VAN", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-vgk", name: "Vegas Golden Knights", shortName: "Golden Knights", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/vgk.png", accent: "#B4975A", league: "NHL", leagueTag: "NHL", conference: "Pacific Division", espnUrl: "https://www.espn.com/nhl/team/_/name/vgk/vegas-golden-knights", ticketUrl: "https://www.nhl.com/vgk/vegas-golden-knights/tickets", venue: "T-Mobile Arena", apiTeam: "sports/hockey/nhl/teams/37", apiSchedule: "sports/hockey/nhl/teams/37/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/37/roster", teamId: "37", espnAbbr: "VGK", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-wsh", name: "Washington Capitals", shortName: "Capitals", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/wsh.png", accent: "#d71830", league: "NHL", leagueTag: "NHL", conference: "Metropolitan Division", espnUrl: "https://www.espn.com/nhl/team/_/name/wsh/washington-capitals", ticketUrl: "https://www.nhl.com/wsh/washington-capitals/tickets", venue: "Capital One Arena", apiTeam: "sports/hockey/nhl/teams/23", apiSchedule: "sports/hockey/nhl/teams/23/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/23/roster", teamId: "23", espnAbbr: "WSH", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  { id: "nhl-wpg", name: "Winnipeg Jets", shortName: "Jets", logo: "https://a.espncdn.com/i/teamlogos/nhl/500/wpg.png", accent: "#002d62", league: "NHL", leagueTag: "NHL", conference: "Central Division", espnUrl: "https://www.espn.com/nhl/team/_/name/wpg/winnipeg-jets", ticketUrl: "https://www.nhl.com/wpg/winnipeg-jets/tickets", venue: "Canada Life Centre", apiTeam: "sports/hockey/nhl/teams/28", apiSchedule: "sports/hockey/nhl/teams/28/schedule", apiStandings: "sports/hockey/nhl/standings", apiRoster: "sports/hockey/nhl/teams/28/roster", teamId: "28", espnAbbr: "WPG", sport: "hockey", isHockey: true, showPlayoffOdds: false, hasSalary: true, salaryCap: "$88M" },
  // --- NFL Teams ---
  { id: "nfl-ari", name: "Arizona Cardinals", shortName: "Cardinals", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/ari.png", accent: "#A40227", league: "NFL", leagueTag: "NFL", conference: "NFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/ari/arizona-cardinals", ticketUrl: "https://www.nfl.com/teams/arizona-cardinals/tickets", venue: "State Farm Stadium", apiTeam: "sports/football/nfl/teams/22", apiSchedule: "sports/football/nfl/teams/22/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/22/roster", teamId: "22", espnAbbr: "ARI", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-atl", name: "Atlanta Falcons", shortName: "Falcons", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/atl.png", accent: "#A71930", league: "NFL", leagueTag: "NFL", conference: "NFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/atl/atlanta-falcons", ticketUrl: "https://www.nfl.com/teams/atlanta-falcons/tickets", venue: "Mercedes-Benz Stadium", apiTeam: "sports/football/nfl/teams/1", apiSchedule: "sports/football/nfl/teams/1/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/1/roster", teamId: "1", espnAbbr: "ATL", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-bal", name: "Baltimore Ravens", shortName: "Ravens", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/bal.png", accent: "#29126F", league: "NFL", leagueTag: "NFL", conference: "AFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/bal/baltimore-ravens", ticketUrl: "https://www.nfl.com/teams/baltimore-ravens/tickets", venue: "M&T Bank Stadium", apiTeam: "sports/football/nfl/teams/33", apiSchedule: "sports/football/nfl/teams/33/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/33/roster", teamId: "33", espnAbbr: "BAL", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-buf", name: "Buffalo Bills", shortName: "Bills", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/buf.png", accent: "#00338D", league: "NFL", leagueTag: "NFL", conference: "AFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/buf/buffalo-bills", ticketUrl: "https://www.nfl.com/teams/buffalo-bills/tickets", venue: "Highmark Stadium", apiTeam: "sports/football/nfl/teams/2", apiSchedule: "sports/football/nfl/teams/2/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/2/roster", teamId: "2", espnAbbr: "BUF", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-car", name: "Carolina Panthers", shortName: "Panthers", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/car.png", accent: "#0085CA", league: "NFL", leagueTag: "NFL", conference: "NFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/car/carolina-panthers", ticketUrl: "https://www.nfl.com/teams/carolina-panthers/tickets", venue: "Bank of America Stadium", apiTeam: "sports/football/nfl/teams/29", apiSchedule: "sports/football/nfl/teams/29/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/29/roster", teamId: "29", espnAbbr: "CAR", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-chi", name: "Chicago Bears", shortName: "Bears", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/chi.png", accent: "#0B162A", league: "NFL", leagueTag: "NFL", conference: "NFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/chi/chicago-bears", ticketUrl: "https://www.nfl.com/teams/chicago-bears/tickets", venue: "Soldier Field", apiTeam: "sports/football/nfl/teams/3", apiSchedule: "sports/football/nfl/teams/3/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/3/roster", teamId: "3", espnAbbr: "CHI", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-cin", name: "Cincinnati Bengals", shortName: "Bengals", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/cin.png", accent: "#FB4F14", league: "NFL", leagueTag: "NFL", conference: "AFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/cin/cincinnati-bengals", ticketUrl: "https://www.nfl.com/teams/cincinnati-bengals/tickets", venue: "Paycor Stadium", apiTeam: "sports/football/nfl/teams/4", apiSchedule: "sports/football/nfl/teams/4/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/4/roster", teamId: "4", espnAbbr: "CIN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-cle", name: "Cleveland Browns", shortName: "Browns", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/cle.png", accent: "#FF3C00", league: "NFL", leagueTag: "NFL", conference: "AFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/cle/cleveland-browns", ticketUrl: "https://www.nfl.com/teams/cleveland-browns/tickets", venue: "Huntington Bank Field", apiTeam: "sports/football/nfl/teams/5", apiSchedule: "sports/football/nfl/teams/5/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/5/roster", teamId: "5", espnAbbr: "CLE", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-dal", name: "Dallas Cowboys", shortName: "Cowboys", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/dal.png", accent: "#002A5C", league: "NFL", leagueTag: "NFL", conference: "NFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/dal/dallas-cowboys", ticketUrl: "https://www.nfl.com/teams/dallas-cowboys/tickets", venue: "AT&T Stadium", apiTeam: "sports/football/nfl/teams/6", apiSchedule: "sports/football/nfl/teams/6/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/6/roster", teamId: "6", espnAbbr: "DAL", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-den", name: "Denver Broncos", shortName: "Broncos", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/den.png", accent: "#FB4F14", league: "NFL", leagueTag: "NFL", conference: "AFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/den/denver-broncos", ticketUrl: "https://www.nfl.com/teams/denver-broncos/tickets", venue: "Empower Field at Mile High", apiTeam: "sports/football/nfl/teams/7", apiSchedule: "sports/football/nfl/teams/7/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/7/roster", teamId: "7", espnAbbr: "DEN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-det", name: "Detroit Lions", shortName: "Lions", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/det.png", accent: "#0076B6", league: "NFL", leagueTag: "NFL", conference: "NFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/det/detroit-lions", ticketUrl: "https://www.nfl.com/teams/detroit-lions/tickets", venue: "Ford Field", apiTeam: "sports/football/nfl/teams/8", apiSchedule: "sports/football/nfl/teams/8/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/8/roster", teamId: "8", espnAbbr: "DET", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-gb", name: "Green Bay Packers", shortName: "Packers", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/gb.png", accent: "#204E32", league: "NFL", leagueTag: "NFL", conference: "NFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/gb/green-bay-packers", ticketUrl: "https://www.nfl.com/teams/green-bay-packers/tickets", venue: "Lambeau Field", apiTeam: "sports/football/nfl/teams/9", apiSchedule: "sports/football/nfl/teams/9/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/9/roster", teamId: "9", espnAbbr: "GB", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-hou", name: "Houston Texans", shortName: "Texans", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/hou.png", accent: "#03202F", league: "NFL", leagueTag: "NFL", conference: "AFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/hou/houston-texans", ticketUrl: "https://www.nfl.com/teams/houston-texans/tickets", venue: "NRG Stadium", apiTeam: "sports/football/nfl/teams/34", apiSchedule: "sports/football/nfl/teams/34/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/34/roster", teamId: "34", espnAbbr: "HOU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-ind", name: "Indianapolis Colts", shortName: "Colts", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/ind.png", accent: "#003B75", league: "NFL", leagueTag: "NFL", conference: "AFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/ind/indianapolis-colts", ticketUrl: "https://www.nfl.com/teams/indianapolis-colts/tickets", venue: "Lucas Oil Stadium", apiTeam: "sports/football/nfl/teams/11", apiSchedule: "sports/football/nfl/teams/11/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/11/roster", teamId: "11", espnAbbr: "IND", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-jax", name: "Jacksonville Jaguars", shortName: "Jaguars", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/jax.png", accent: "#007487", league: "NFL", leagueTag: "NFL", conference: "AFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/jax/jacksonville-jaguars", ticketUrl: "https://www.nfl.com/teams/jacksonville-jaguars/tickets", venue: "EverBank Stadium", apiTeam: "sports/football/nfl/teams/30", apiSchedule: "sports/football/nfl/teams/30/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/30/roster", teamId: "30", espnAbbr: "JAX", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-kc", name: "Kansas City Chiefs", shortName: "Chiefs", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/kc.png", accent: "#E31837", league: "NFL", leagueTag: "NFL", conference: "AFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/kc/kansas-city-chiefs", ticketUrl: "https://www.nfl.com/teams/kansas-city-chiefs/tickets", venue: "GEHA Field at Arrowhead Stadium", apiTeam: "sports/football/nfl/teams/12", apiSchedule: "sports/football/nfl/teams/12/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/12/roster", teamId: "12", espnAbbr: "KC", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-lv", name: "Las Vegas Raiders", shortName: "Raiders", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/lv.png", accent: "#A5ACAF", league: "NFL", leagueTag: "NFL", conference: "AFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/lv/las-vegas-raiders", ticketUrl: "https://www.nfl.com/teams/las-vegas-raiders/tickets", venue: "Allegiant Stadium", apiTeam: "sports/football/nfl/teams/13", apiSchedule: "sports/football/nfl/teams/13/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/13/roster", teamId: "13", espnAbbr: "LV", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-lac", name: "Los Angeles Chargers", shortName: "Chargers", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/lac.png", accent: "#0080C6", league: "NFL", leagueTag: "NFL", conference: "AFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/lac/los-angeles-chargers", ticketUrl: "https://www.nfl.com/teams/los-angeles-chargers/tickets", venue: "SoFi Stadium", apiTeam: "sports/football/nfl/teams/24", apiSchedule: "sports/football/nfl/teams/24/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/24/roster", teamId: "24", espnAbbr: "LAC", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-lar", name: "Los Angeles Rams", shortName: "Rams", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/lar.png", accent: "#003594", league: "NFL", leagueTag: "NFL", conference: "NFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/lar/los-angeles-rams", ticketUrl: "https://www.nfl.com/teams/los-angeles-rams/tickets", venue: "SoFi Stadium", apiTeam: "sports/football/nfl/teams/14", apiSchedule: "sports/football/nfl/teams/14/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/14/roster", teamId: "14", espnAbbr: "LAR", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-mia", name: "Miami Dolphins", shortName: "Dolphins", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/mia.png", accent: "#008E97", league: "NFL", leagueTag: "NFL", conference: "AFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/mia/miami-dolphins", ticketUrl: "https://www.nfl.com/teams/miami-dolphins/tickets", venue: "Hard Rock Stadium", apiTeam: "sports/football/nfl/teams/15", apiSchedule: "sports/football/nfl/teams/15/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/15/roster", teamId: "15", espnAbbr: "MIA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-min", name: "Minnesota Vikings", shortName: "Vikings", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/min.png", accent: "#4F2683", league: "NFL", leagueTag: "NFL", conference: "NFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/min/minnesota-vikings", ticketUrl: "https://www.nfl.com/teams/minnesota-vikings/tickets", venue: "U.S. Bank Stadium", apiTeam: "sports/football/nfl/teams/16", apiSchedule: "sports/football/nfl/teams/16/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/16/roster", teamId: "16", espnAbbr: "MIN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-ne", name: "New England Patriots", shortName: "Patriots", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/ne.png", accent: "#002A5C", league: "NFL", leagueTag: "NFL", conference: "AFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/ne/new-england-patriots", ticketUrl: "https://www.nfl.com/teams/new-england-patriots/tickets", venue: "Gillette Stadium", apiTeam: "sports/football/nfl/teams/17", apiSchedule: "sports/football/nfl/teams/17/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/17/roster", teamId: "17", espnAbbr: "NE", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-no", name: "New Orleans Saints", shortName: "Saints", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/no.png", accent: "#D3BC8D", league: "NFL", leagueTag: "NFL", conference: "NFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/no/new-orleans-saints", ticketUrl: "https://www.nfl.com/teams/new-orleans-saints/tickets", venue: "Caesars Superdome", apiTeam: "sports/football/nfl/teams/18", apiSchedule: "sports/football/nfl/teams/18/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/18/roster", teamId: "18", espnAbbr: "NO", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-nyg", name: "New York Giants", shortName: "Giants", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/nyg.png", accent: "#003C7F", league: "NFL", leagueTag: "NFL", conference: "NFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/nyg/new-york-giants", ticketUrl: "https://www.nfl.com/teams/new-york-giants/tickets", venue: "MetLife Stadium", apiTeam: "sports/football/nfl/teams/19", apiSchedule: "sports/football/nfl/teams/19/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/19/roster", teamId: "19", espnAbbr: "NYG", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-nyj", name: "New York Jets", shortName: "Jets", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/nyj.png", accent: "#115740", league: "NFL", leagueTag: "NFL", conference: "AFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/nyj/new-york-jets", ticketUrl: "https://www.nfl.com/teams/new-york-jets/tickets", venue: "MetLife Stadium", apiTeam: "sports/football/nfl/teams/20", apiSchedule: "sports/football/nfl/teams/20/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/20/roster", teamId: "20", espnAbbr: "NYJ", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-phi", name: "Philadelphia Eagles", shortName: "Eagles", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/phi.png", accent: "#06424D", league: "NFL", leagueTag: "NFL", conference: "NFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/phi/philadelphia-eagles", ticketUrl: "https://www.nfl.com/teams/philadelphia-eagles/tickets", venue: "Lincoln Financial Field", apiTeam: "sports/football/nfl/teams/21", apiSchedule: "sports/football/nfl/teams/21/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/21/roster", teamId: "21", espnAbbr: "PHI", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-pit", name: "Pittsburgh Steelers", shortName: "Steelers", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/pit.png", accent: "#FFB612", league: "NFL", leagueTag: "NFL", conference: "AFC North", espnUrl: "https://www.espn.com/nfl/team/_/name/pit/pittsburgh-steelers", ticketUrl: "https://www.nfl.com/teams/pittsburgh-steelers/tickets", venue: "Acrisure Stadium", apiTeam: "sports/football/nfl/teams/23", apiSchedule: "sports/football/nfl/teams/23/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/23/roster", teamId: "23", espnAbbr: "PIT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-sf", name: "San Francisco 49ers", shortName: "49ers", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/sf.png", accent: "#AA0000", league: "NFL", leagueTag: "NFL", conference: "NFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/sf/san-francisco-49ers", ticketUrl: "https://www.nfl.com/teams/san-francisco-49ers/tickets", venue: "Levi's Stadium", apiTeam: "sports/football/nfl/teams/25", apiSchedule: "sports/football/nfl/teams/25/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/25/roster", teamId: "25", espnAbbr: "SF", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-sea", name: "Seattle Seahawks", shortName: "Seahawks", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/sea.png", accent: "#002A5C", league: "NFL", leagueTag: "NFL", conference: "NFC West", espnUrl: "https://www.espn.com/nfl/team/_/name/sea/seattle-seahawks", ticketUrl: "https://www.nfl.com/teams/seattle-seahawks/tickets", venue: "Lumen Field", apiTeam: "sports/football/nfl/teams/26", apiSchedule: "sports/football/nfl/teams/26/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/26/roster", teamId: "26", espnAbbr: "SEA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-tb", name: "Tampa Bay Buccaneers", shortName: "Buccaneers", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/tb.png", accent: "#BD1C36", league: "NFL", leagueTag: "NFL", conference: "NFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/tb/tampa-bay-buccaneers", ticketUrl: "https://www.nfl.com/teams/tampa-bay-buccaneers/tickets", venue: "Raymond James Stadium", apiTeam: "sports/football/nfl/teams/27", apiSchedule: "sports/football/nfl/teams/27/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/27/roster", teamId: "27", espnAbbr: "TB", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-ten", name: "Tennessee Titans", shortName: "Titans", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/ten.png", accent: "#4B92DB", league: "NFL", leagueTag: "NFL", conference: "AFC South", espnUrl: "https://www.espn.com/nfl/team/_/name/ten/tennessee-titans", ticketUrl: "https://www.nfl.com/teams/tennessee-titans/tickets", venue: "Nissan Stadium", apiTeam: "sports/football/nfl/teams/10", apiSchedule: "sports/football/nfl/teams/10/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/10/roster", teamId: "10", espnAbbr: "TEN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },
  { id: "nfl-wsh", name: "Washington Commanders", shortName: "Commanders", logo: "https://a.espncdn.com/i/teamlogos/nfl/500/wsh.png", accent: "#5A1414", league: "NFL", leagueTag: "NFL", conference: "NFC East", espnUrl: "https://www.espn.com/nfl/team/_/name/wsh/washington-commanders", ticketUrl: "https://www.nfl.com/teams/washington-commanders/tickets", venue: "Northwest Stadium", apiTeam: "sports/football/nfl/teams/28", apiSchedule: "sports/football/nfl/teams/28/schedule", apiStandings: "sports/football/nfl/standings", apiRoster: "sports/football/nfl/teams/28/roster", teamId: "28", espnAbbr: "WSH", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: true, salaryCap: "$255.4M" },

  // --- NCAA FBS Football Teams ---
  { id: "ncaaf-unt", name: "North Texas Mean Green", shortName: "North Texas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/249.png", accent: "#068f33", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/249", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/249", apiSchedule: "sports/football/college-football/teams/249/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/249/roster", teamId: "249", espnAbbr: "UNT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-tuln", name: "Tulane Green Wave", shortName: "Tulane", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2655.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2655", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2655", apiSchedule: "sports/football/college-football/teams/2655/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2655/roster", teamId: "2655", espnAbbr: "TULN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ecu", name: "East Carolina Pirates", shortName: "East Carolina", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/151.png", accent: "#582c83", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/151", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/151", apiSchedule: "sports/football/college-football/teams/151/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/151/roster", teamId: "151", espnAbbr: "ECU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-usf", name: "South Florida Bulls", shortName: "South Florida", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/58.png", accent: "#006747", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/58", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/58", apiSchedule: "sports/football/college-football/teams/58/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/58/roster", teamId: "58", espnAbbr: "USF", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-mem", name: "Memphis Tigers", shortName: "Memphis", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/235.png", accent: "#004991", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/235", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/235", apiSchedule: "sports/football/college-football/teams/235/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/235/roster", teamId: "235", espnAbbr: "MEM", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-utsa", name: "UTSA Roadrunners", shortName: "UTSA", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2636.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2636", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2636", apiSchedule: "sports/football/college-football/teams/2636/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2636/roster", teamId: "2636", espnAbbr: "UTSA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-tem", name: "Temple Owls", shortName: "Temple", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/218.png", accent: "#a41e35", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/218", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/218", apiSchedule: "sports/football/college-football/teams/218/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/218/roster", teamId: "218", espnAbbr: "TEM", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-rice", name: "Rice Owls", shortName: "Rice", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/242.png", accent: "#00205b", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/242", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/242", apiSchedule: "sports/football/college-football/teams/242/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/242/roster", teamId: "242", espnAbbr: "RICE", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-fau", name: "Florida Atlantic Owls", shortName: "FAU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2226.png", accent: "#003366", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2226", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2226", apiSchedule: "sports/football/college-football/teams/2226/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2226/roster", teamId: "2226", espnAbbr: "FAU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-tlsa", name: "Tulsa Golden Hurricane", shortName: "Tulsa", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/202.png", accent: "#003595", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/202", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/202", apiSchedule: "sports/football/college-football/teams/202/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/202/roster", teamId: "202", espnAbbr: "TLSA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-clt", name: "Charlotte 49ers", shortName: "Charlotte", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2429.png", accent: "#005035", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2429", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2429", apiSchedule: "sports/football/college-football/teams/2429/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2429/roster", teamId: "2429", espnAbbr: "CLT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-navy", name: "Navy Midshipmen", shortName: "Navy", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2426.png", accent: "#00225b", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2426", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2426", apiSchedule: "sports/football/college-football/teams/2426/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2426/roster", teamId: "2426", espnAbbr: "NAVY", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-army", name: "Army Black Knights", shortName: "Army", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/349.png", accent: "#000000", league: "NCAAF", leagueTag: "NCAAF", conference: "American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/349", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/349", apiSchedule: "sports/football/college-football/teams/349/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/349/roster", teamId: "349", espnAbbr: "ARMY", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-mia", name: "Miami Hurricanes", shortName: "Miami", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2390.png", accent: "#f47423", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2390", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2390", apiSchedule: "sports/football/college-football/teams/2390/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2390/roster", teamId: "2390", espnAbbr: "MIA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-uva", name: "Virginia Cavaliers", shortName: "Virginia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/258.png", accent: "#f84c1e", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/258", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/258", apiSchedule: "sports/football/college-football/teams/258/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/258/roster", teamId: "258", espnAbbr: "UVA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-smu", name: "SMU Mustangs", shortName: "SMU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2567.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2567", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2567", apiSchedule: "sports/football/college-football/teams/2567/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2567/roster", teamId: "2567", espnAbbr: "SMU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-gt", name: "Georgia Tech Yellow Jackets", shortName: "Georgia Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/59.png", accent: "#b3a369", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/59", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/59", apiSchedule: "sports/football/college-football/teams/59/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/59/roster", teamId: "59", espnAbbr: "GT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-lou", name: "Louisville Cardinals", shortName: "Louisville", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/97.png", accent: "#c9001f", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/97", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/97", apiSchedule: "sports/football/college-football/teams/97/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/97/roster", teamId: "97", espnAbbr: "LOU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wake", name: "Wake Forest Demon Deacons", shortName: "Wake Forest", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/154.png", accent: "#ceb888", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/154", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/154", apiSchedule: "sports/football/college-football/teams/154/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/154/roster", teamId: "154", espnAbbr: "WAKE", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-duke", name: "Duke Blue Devils", shortName: "Duke", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/150.png", accent: "#00539b", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/150", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/150", apiSchedule: "sports/football/college-football/teams/150/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/150/roster", teamId: "150", espnAbbr: "DUKE", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-pitt", name: "Pittsburgh Panthers", shortName: "Pitt", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/221.png", accent: "#003594", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/221", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/221", apiSchedule: "sports/football/college-football/teams/221/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/221/roster", teamId: "221", espnAbbr: "PITT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ncsu", name: "NC State Wolfpack", shortName: "NC State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/152.png", accent: "#cc0000", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/152", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/152", apiSchedule: "sports/football/college-football/teams/152/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/152/roster", teamId: "152", espnAbbr: "NCSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-clem", name: "Clemson Tigers", shortName: "Clemson", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/228.png", accent: "#f56600", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/228", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/228", apiSchedule: "sports/football/college-football/teams/228/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/228/roster", teamId: "228", espnAbbr: "CLEM", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-fsu", name: "Florida State Seminoles", shortName: "Florida St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/52.png", accent: "#782f40", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/52", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/52", apiSchedule: "sports/football/college-football/teams/52/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/52/roster", teamId: "52", espnAbbr: "FSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-unc", name: "North Carolina Tar Heels", shortName: "North Carolina", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/153.png", accent: "#7bafd4", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/153", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/153", apiSchedule: "sports/football/college-football/teams/153/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/153/roster", teamId: "153", espnAbbr: "UNC", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-vt", name: "Virginia Tech Hokies", shortName: "Virginia Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/259.png", accent: "#6a2c3e", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/259", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/259", apiSchedule: "sports/football/college-football/teams/259/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/259/roster", teamId: "259", espnAbbr: "VT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-syr", name: "Syracuse Orange", shortName: "Syracuse", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/183.png", accent: "#000e54", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/183", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/183", apiSchedule: "sports/football/college-football/teams/183/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/183/roster", teamId: "183", espnAbbr: "SYR", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-bc", name: "Boston College Eagles", shortName: "Boston College", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/103.png", accent: "#8c2232", league: "NCAAF", leagueTag: "NCAAF", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/103", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/103", apiSchedule: "sports/football/college-football/teams/103/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/103/roster", teamId: "103", espnAbbr: "BC", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ttu", name: "Texas Tech Red Raiders", shortName: "Texas Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2641.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2641", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2641", apiSchedule: "sports/football/college-football/teams/2641/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2641/roster", teamId: "2641", espnAbbr: "TTU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-hou", name: "Houston Cougars", shortName: "Houston", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/248.png", accent: "#c8102e", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/248", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/248", apiSchedule: "sports/football/college-football/teams/248/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/248/roster", teamId: "248", espnAbbr: "HOU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-tcu", name: "TCU Horned Frogs", shortName: "TCU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2628.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2628", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2628", apiSchedule: "sports/football/college-football/teams/2628/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2628/roster", teamId: "2628", espnAbbr: "TCU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-isu", name: "Iowa State Cyclones", shortName: "Iowa State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/66.png", accent: "#ae192d", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/66", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/66", apiSchedule: "sports/football/college-football/teams/66/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/66/roster", teamId: "66", espnAbbr: "ISU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-cin", name: "Cincinnati Bearcats", shortName: "Cincinnati", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2132.png", accent: "#000000", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2132", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2132", apiSchedule: "sports/football/college-football/teams/2132/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2132/roster", teamId: "2132", espnAbbr: "CIN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ksu", name: "Kansas State Wildcats", shortName: "Kansas St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2306.png", accent: "#330a57", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2306", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2306", apiSchedule: "sports/football/college-football/teams/2306/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2306/roster", teamId: "2306", espnAbbr: "KSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-bay", name: "Baylor Bears", shortName: "Baylor", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/239.png", accent: "#154734", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/239", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/239", apiSchedule: "sports/football/college-football/teams/239/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/239/roster", teamId: "239", espnAbbr: "BAY", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ku", name: "Kansas Jayhawks", shortName: "Kansas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2305.png", accent: "#0051ba", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2305", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2305", apiSchedule: "sports/football/college-football/teams/2305/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2305/roster", teamId: "2305", espnAbbr: "KU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ucf", name: "UCF Knights", shortName: "UCF", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2116.png", accent: "#000000", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2116", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2116", apiSchedule: "sports/football/college-football/teams/2116/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2116/roster", teamId: "2116", espnAbbr: "UCF", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wvu", name: "West Virginia Mountaineers", shortName: "West Virginia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/277.png", accent: "#eaaa00", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/277", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/277", apiSchedule: "sports/football/college-football/teams/277/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/277/roster", teamId: "277", espnAbbr: "WVU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-colo", name: "Colorado Buffaloes", shortName: "Colorado", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/38.png", accent: "#cfb87c", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/38", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/38", apiSchedule: "sports/football/college-football/teams/38/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/38/roster", teamId: "38", espnAbbr: "COLO", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-okst", name: "Oklahoma State Cowboys", shortName: "Oklahoma St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/197.png", accent: "#fe5c00", league: "NCAAF", leagueTag: "NCAAF", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/197", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/197", apiSchedule: "sports/football/college-football/teams/197/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/197/roster", teamId: "197", espnAbbr: "OKST", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-iu", name: "Indiana Hoosiers", shortName: "Indiana", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/84.png", accent: "#970310", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/84", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/84", apiSchedule: "sports/football/college-football/teams/84/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/84/roster", teamId: "84", espnAbbr: "IU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ore", name: "Oregon Ducks", shortName: "Oregon", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2483.png", accent: "#00934b", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2483", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2483", apiSchedule: "sports/football/college-football/teams/2483/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2483/roster", teamId: "2483", espnAbbr: "ORE", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-osu", name: "Ohio State Buckeyes", shortName: "Ohio State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png", accent: "#ba0c2f", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/194", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/194", apiSchedule: "sports/football/college-football/teams/194/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/194/roster", teamId: "194", espnAbbr: "OSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-mich", name: "Michigan Wolverines", shortName: "Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/130.png", accent: "#00274c", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/130", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/130", apiSchedule: "sports/football/college-football/teams/130/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/130/roster", teamId: "130", espnAbbr: "MICH", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-iowa", name: "Iowa Hawkeyes", shortName: "Iowa", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2294.png", accent: "#231f20", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2294", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2294", apiSchedule: "sports/football/college-football/teams/2294/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2294/roster", teamId: "2294", espnAbbr: "IOWA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ill", name: "Illinois Fighting Illini", shortName: "Illinois", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/356.png", accent: "#ff5f05", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/356", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/356", apiSchedule: "sports/football/college-football/teams/356/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/356/roster", teamId: "356", espnAbbr: "ILL", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-minn", name: "Minnesota Golden Gophers", shortName: "Minnesota", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/135.png", accent: "#5e0a2f", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/135", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/135", apiSchedule: "sports/football/college-football/teams/135/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/135/roster", teamId: "135", espnAbbr: "MINN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-neb", name: "Nebraska Cornhuskers", shortName: "Nebraska", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/158.png", accent: "#e31937", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/158", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/158", apiSchedule: "sports/football/college-football/teams/158/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/158/roster", teamId: "158", espnAbbr: "NEB", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-nu", name: "Northwestern Wildcats", shortName: "Northwestern", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/77.png", accent: "#492f92", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/77", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/77", apiSchedule: "sports/football/college-football/teams/77/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/77/roster", teamId: "77", espnAbbr: "NU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-psu", name: "Penn State Nittany Lions", shortName: "Penn State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/213.png", accent: "#061440", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/213", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/213", apiSchedule: "sports/football/college-football/teams/213/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/213/roster", teamId: "213", espnAbbr: "PSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-rutg", name: "Rutgers Scarlet Knights", shortName: "Rutgers", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/164.png", accent: "#ce0e2d", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/164", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/164", apiSchedule: "sports/football/college-football/teams/164/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/164/roster", teamId: "164", espnAbbr: "RUTG", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wis", name: "Wisconsin Badgers", shortName: "Wisconsin", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/275.png", accent: "#a00000", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/275", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/275", apiSchedule: "sports/football/college-football/teams/275/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/275/roster", teamId: "275", espnAbbr: "WIS", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-msu", name: "Michigan State Spartans", shortName: "Michigan St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/127.png", accent: "#173f35", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/127", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/127", apiSchedule: "sports/football/college-football/teams/127/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/127/roster", teamId: "127", espnAbbr: "MSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-md", name: "Maryland Terrapins", shortName: "Maryland", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/120.png", accent: "#ce1126", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/120", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/120", apiSchedule: "sports/football/college-football/teams/120/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/120/roster", teamId: "120", espnAbbr: "MD", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-pur", name: "Purdue Boilermakers", shortName: "Purdue", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2509.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2509", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2509", apiSchedule: "sports/football/college-football/teams/2509/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2509/roster", teamId: "2509", espnAbbr: "PUR", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wash", name: "Washington Huskies", shortName: "Washington", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/264.png", accent: "#33006f", league: "NCAAF", leagueTag: "NCAAF", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/264", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/264", apiSchedule: "sports/football/college-football/teams/264/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/264/roster", teamId: "264", espnAbbr: "WASH", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-kenn", name: "Kennesaw State Owls", shortName: "Kennesaw St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/338.png", accent: "#fdbb30", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/338", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/338", apiSchedule: "sports/football/college-football/teams/338/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/338/roster", teamId: "338", espnAbbr: "KENN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wku", name: "Western Kentucky Hilltoppers", shortName: "Western KY", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/98.png", accent: "#e13a3e", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/98", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/98", apiSchedule: "sports/football/college-football/teams/98/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/98/roster", teamId: "98", espnAbbr: "WKU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-jvst", name: "Jacksonville State Gamecocks", shortName: "Jax State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/55.png", accent: "#cc0000", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/55", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/55", apiSchedule: "sports/football/college-football/teams/55/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/55/roster", teamId: "55", espnAbbr: "JVST", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-lt", name: "Louisiana Tech Bulldogs", shortName: "Louisiana Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2348.png", accent: "#003087", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/2348", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2348", apiSchedule: "sports/football/college-football/teams/2348/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2348/roster", teamId: "2348", espnAbbr: "LT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-most", name: "Missouri State Bears", shortName: "Missouri St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2623.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/2623", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2623", apiSchedule: "sports/football/college-football/teams/2623/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2623/roster", teamId: "2623", espnAbbr: "MOST", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-fiu", name: "Florida International Panthers", shortName: "FIU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2229.png", accent: "#091f3f", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/2229", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2229", apiSchedule: "sports/football/college-football/teams/2229/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2229/roster", teamId: "2229", espnAbbr: "FIU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-del", name: "Delaware Blue Hens", shortName: "Delaware", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/48.png", accent: "#00539f", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/48", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/48", apiSchedule: "sports/football/college-football/teams/48/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/48/roster", teamId: "48", espnAbbr: "DEL", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-lib", name: "Liberty Flames", shortName: "Liberty", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2335.png", accent: "#0a254e", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/2335", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2335", apiSchedule: "sports/football/college-football/teams/2335/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2335/roster", teamId: "2335", espnAbbr: "LIB", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-nmsu", name: "New Mexico State Aggies", shortName: "New Mexico St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/166.png", accent: "#7e141b", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/166", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/166", apiSchedule: "sports/football/college-football/teams/166/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/166/roster", teamId: "166", espnAbbr: "NMSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-mtsu", name: "Middle Tennessee Blue Raiders", shortName: "MTSU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2393.png", accent: "#036eb7", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/2393", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2393", apiSchedule: "sports/football/college-football/teams/2393/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2393/roster", teamId: "2393", espnAbbr: "MTSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-utep", name: "UTEP Miners", shortName: "UTEP", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2638.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/2638", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2638", apiSchedule: "sports/football/college-football/teams/2638/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2638/roster", teamId: "2638", espnAbbr: "UTEP", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-shsu", name: "Sam Houston Bearkats", shortName: "Sam Houston", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2534.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Conference USA", espnUrl: "https://www.espn.com/college-football/team/_/id/2534", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2534", apiSchedule: "sports/football/college-football/teams/2534/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2534/roster", teamId: "2534", espnAbbr: "SHSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-nd", name: "Notre Dame Fighting Irish", shortName: "Notre Dame", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/87.png", accent: "#062340", league: "NCAAF", leagueTag: "NCAAF", conference: "FBS Independents", espnUrl: "https://www.espn.com/college-football/team/_/id/87", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/87", apiSchedule: "sports/football/college-football/teams/87/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/87/roster", teamId: "87", espnAbbr: "ND", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-conn", name: "UConn Huskies", shortName: "UConn", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/41.png", accent: "#0c2340", league: "NCAAF", leagueTag: "NCAAF", conference: "FBS Independents", espnUrl: "https://www.espn.com/college-football/team/_/id/41", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/41", apiSchedule: "sports/football/college-football/teams/41/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/41/roster", teamId: "41", espnAbbr: "CONN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wmu", name: "Western Michigan Broncos", shortName: "W Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2711.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2711", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2711", apiSchedule: "sports/football/college-football/teams/2711/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2711/roster", teamId: "2711", espnAbbr: "WMU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ohio", name: "Ohio Bobcats", shortName: "Ohio", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/195.png", accent: "#154734", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/195", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/195", apiSchedule: "sports/football/college-football/teams/195/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/195/roster", teamId: "195", espnAbbr: "OHIO", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-tol", name: "Toledo Rockets", shortName: "Toledo", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2649.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2649", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2649", apiSchedule: "sports/football/college-football/teams/2649/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2649/roster", teamId: "2649", espnAbbr: "TOL", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-cmu", name: "Central Michigan Chippewas", shortName: "C Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2117.png", accent: "#4c0027", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2117", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2117", apiSchedule: "sports/football/college-football/teams/2117/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2117/roster", teamId: "2117", espnAbbr: "CMU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-m-oh", name: "Miami (OH) RedHawks", shortName: "Miami OH", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/193.png", accent: "#c41230", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/193", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/193", apiSchedule: "sports/football/college-football/teams/193/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/193/roster", teamId: "193", espnAbbr: "M-OH", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-akr", name: "Akron Zips", shortName: "Akron", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2006.png", accent: "#041e42", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2006", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2006", apiSchedule: "sports/football/college-football/teams/2006/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2006/roster", teamId: "2006", espnAbbr: "AKR", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-buff", name: "Buffalo Bulls", shortName: "Buffalo", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2084.png", accent: "#005bbb", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2084", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2084", apiSchedule: "sports/football/college-football/teams/2084/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2084/roster", teamId: "2084", espnAbbr: "BUFF", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-kent", name: "Kent State Golden Flashes", shortName: "Kent State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2309.png", accent: "#002664", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2309", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2309", apiSchedule: "sports/football/college-football/teams/2309/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2309/roster", teamId: "2309", espnAbbr: "KENT", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-emu", name: "Eastern Michigan Eagles", shortName: "E Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2199.png", accent: "#006938", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2199", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2199", apiSchedule: "sports/football/college-football/teams/2199/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2199/roster", teamId: "2199", espnAbbr: "EMU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ball", name: "Ball State Cardinals", shortName: "Ball State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2050.png", accent: "#ba0c2f", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2050", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2050", apiSchedule: "sports/football/college-football/teams/2050/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2050/roster", teamId: "2050", espnAbbr: "BALL", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-bgsu", name: "Bowling Green Falcons", shortName: "Bowling Green", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/189.png", accent: "#fd5000", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/189", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/189", apiSchedule: "sports/football/college-football/teams/189/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/189/roster", teamId: "189", espnAbbr: "BGSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-niu", name: "Northern Illinois Huskies", shortName: "N Illinois", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2459.png", accent: "#c8102e", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2459", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2459", apiSchedule: "sports/football/college-football/teams/2459/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2459/roster", teamId: "2459", espnAbbr: "NIU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-mass", name: "Massachusetts Minutemen", shortName: "UMass", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/113.png", accent: "#881c1c", league: "NCAAF", leagueTag: "NCAAF", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/113", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/113", apiSchedule: "sports/football/college-football/teams/113/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/113/roster", teamId: "113", espnAbbr: "MASS", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-unlv", name: "UNLV Rebels", shortName: "UNLV", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2439.png", accent: "#cf0a2c", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2439", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2439", apiSchedule: "sports/football/college-football/teams/2439/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2439/roster", teamId: "2439", espnAbbr: "UNLV", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-unm", name: "New Mexico Lobos", shortName: "New Mexico", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/167.png", accent: "#ba0c2f", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/167", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/167", apiSchedule: "sports/football/college-football/teams/167/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/167/roster", teamId: "167", espnAbbr: "UNM", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-fres", name: "Fresno State Bulldogs", shortName: "Fresno St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/278.png", accent: "#b1102b", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/278", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/278", apiSchedule: "sports/football/college-football/teams/278/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/278/roster", teamId: "278", espnAbbr: "FRES", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-haw", name: "Hawai'i Rainbow Warriors", shortName: "Hawai'i", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/62.png", accent: "#005737", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/62", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/62", apiSchedule: "sports/football/college-football/teams/62/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/62/roster", teamId: "62", espnAbbr: "HAW", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-afa", name: "Air Force Falcons", shortName: "Air Force", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2005.png", accent: "#003594", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2005", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2005", apiSchedule: "sports/football/college-football/teams/2005/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2005/roster", teamId: "2005", espnAbbr: "AFA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wyo", name: "Wyoming Cowboys", shortName: "Wyoming", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2751.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2751", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2751", apiSchedule: "sports/football/college-football/teams/2751/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2751/roster", teamId: "2751", espnAbbr: "WYO", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-nev", name: "Nevada Wolf Pack", shortName: "Nevada", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2440.png", accent: "#041e42", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2440", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2440", apiSchedule: "sports/football/college-football/teams/2440/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2440/roster", teamId: "2440", espnAbbr: "NEV", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-csu", name: "Colorado State Rams", shortName: "Colorado St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/36.png", accent: "#004c23", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/36", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/36", apiSchedule: "sports/football/college-football/teams/36/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/36/roster", teamId: "36", espnAbbr: "CSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-bois", name: "Boise State Broncos", shortName: "Boise St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/68.png", accent: "#0033a0", league: "NCAAF", leagueTag: "NCAAF", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/68", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/68", apiSchedule: "sports/football/college-football/teams/68/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/68/roster", teamId: "68", espnAbbr: "BOIS", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-wsu", name: "Washington State Cougars", shortName: "Washington St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/265.png", accent: "#a60f2d", league: "NCAAF", leagueTag: "NCAAF", conference: "Pac-12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/265", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/265", apiSchedule: "sports/football/college-football/teams/265/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/265/roster", teamId: "265", espnAbbr: "WSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-orst", name: "Oregon State Beavers", shortName: "Oregon St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/204.png", accent: "#dc4405", league: "NCAAF", leagueTag: "NCAAF", conference: "Pac-12 Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/204", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/204", apiSchedule: "sports/football/college-football/teams/204/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/204/roster", teamId: "204", espnAbbr: "ORST", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-miss", name: "Ole Miss Rebels", shortName: "Ole Miss", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/145.png", accent: "#13294b", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/145", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/145", apiSchedule: "sports/football/college-football/teams/145/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/145/roster", teamId: "145", espnAbbr: "MISS", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-uga", name: "Georgia Bulldogs", shortName: "Georgia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/61.png", accent: "#ba0c2f", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/61", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/61", apiSchedule: "sports/football/college-football/teams/61/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/61/roster", teamId: "61", espnAbbr: "UGA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ta&m", name: "Texas A&M Aggies", shortName: "Texas A&M", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/245.png", accent: "#500000", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/245", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/245", apiSchedule: "sports/football/college-football/teams/245/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/245/roster", teamId: "245", espnAbbr: "TA&M", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-tex", name: "Texas Longhorns", shortName: "Texas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/251.png", accent: "#af5c37", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/251", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/251", apiSchedule: "sports/football/college-football/teams/251/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/251/roster", teamId: "251", espnAbbr: "TEX", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ou", name: "Oklahoma Sooners", shortName: "Oklahoma", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/201.png", accent: "#990000", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/201", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/201", apiSchedule: "sports/football/college-football/teams/201/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/201/roster", teamId: "201", espnAbbr: "OU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-van", name: "Vanderbilt Commodores", shortName: "Vanderbilt", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/238.png", accent: "#000000", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/238", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/238", apiSchedule: "sports/football/college-football/teams/238/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/238/roster", teamId: "238", espnAbbr: "VAN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-ala", name: "Alabama Crimson Tide", shortName: "Alabama", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/333.png", accent: "#9e1b32", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/333", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/333", apiSchedule: "sports/football/college-football/teams/333/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/333/roster", teamId: "333", espnAbbr: "ALA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-miz", name: "Missouri Tigers", shortName: "Missouri", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/142.png", accent: "#f1b82d", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/142", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/142", apiSchedule: "sports/football/college-football/teams/142/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/142/roster", teamId: "142", espnAbbr: "MIZ", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-tenn", name: "Tennessee Volunteers", shortName: "Tennessee", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2633.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2633", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2633", apiSchedule: "sports/football/college-football/teams/2633/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2633/roster", teamId: "2633", espnAbbr: "TENN", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-lsu", name: "LSU Tigers", shortName: "LSU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/99.png", accent: "#461d76", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/99", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/99", apiSchedule: "sports/football/college-football/teams/99/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/99/roster", teamId: "99", espnAbbr: "LSU", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-uk", name: "Kentucky Wildcats", shortName: "Kentucky", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/96.png", accent: "#0033a0", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/96", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/96", apiSchedule: "sports/football/college-football/teams/96/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/96/roster", teamId: "96", espnAbbr: "UK", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-msst", name: "Mississippi State Bulldogs", shortName: "Mississippi St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/344.png", accent: "#5d1725", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/344", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/344", apiSchedule: "sports/football/college-football/teams/344/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/344/roster", teamId: "344", espnAbbr: "MSST", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-fla", name: "Florida Gators", shortName: "Florida", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/57.png", accent: "#0021a5", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/57", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/57", apiSchedule: "sports/football/college-football/teams/57/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/57/roster", teamId: "57", espnAbbr: "FLA", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaaf-sc", name: "South Carolina Gamecocks", shortName: "South Carolina", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2579.png", accent: "#333333", league: "NCAAF", leagueTag: "NCAAF", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/college-football/team/_/id/2579", ticketUrl: "", venue: "", apiTeam: "sports/football/college-football/teams/2579", apiSchedule: "sports/football/college-football/teams/2579/schedule", apiStandings: "sports/football/college-football/standings", apiRoster: "sports/football/college-football/teams/2579/roster", teamId: "2579", espnAbbr: "SC", sport: "football", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  // --- NCAA D1 Men's Basketball Teams ---
{ id: "ncaam-bing", name: "Binghamton Bearcats", shortName: "Binghamton", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2066.png", accent: "#00614A", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2066", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2066", apiSchedule: "sports/basketball/mens-college-basketball/teams/2066/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2066/roster", teamId: "2066", espnAbbr: "BING", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unh", name: "New Hampshire Wildcats", shortName: "New Hampshire", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/160.png", accent: "#004990", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/160", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/160", apiSchedule: "sports/basketball/mens-college-basketball/teams/160/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/160/roster", teamId: "160", espnAbbr: "UNH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bry", name: "Bryant Bulldogs", shortName: "Bryant", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2803.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2803", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2803", apiSchedule: "sports/basketball/mens-college-basketball/teams/2803/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2803/roster", teamId: "2803", espnAbbr: "BRY", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-me", name: "Maine Black Bears", shortName: "Maine", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/311.png", accent: "#127dbe", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/311", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/311", apiSchedule: "sports/basketball/mens-college-basketball/teams/311/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/311/roster", teamId: "311", espnAbbr: "ME", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ualb", name: "UAlbany Great Danes", shortName: "UAlbany", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/399.png", accent: "#3D2777", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/399", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/399", apiSchedule: "sports/basketball/mens-college-basketball/teams/399/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/399/roster", teamId: "399", espnAbbr: "UALB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uml", name: "UMass Lowell River Hawks", shortName: "UMass Lowell", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2349.png", accent: "#00529C", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2349", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2349", apiSchedule: "sports/basketball/mens-college-basketball/teams/2349/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2349/roster", teamId: "2349", espnAbbr: "UML", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-njit", name: "NJIT Highlanders", shortName: "NJIT", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2885.png", accent: "#EE3024", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2885", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2885", apiSchedule: "sports/basketball/mens-college-basketball/teams/2885/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2885/roster", teamId: "2885", espnAbbr: "NJIT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uvm", name: "Vermont Catamounts", shortName: "Vermont", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/261.png", accent: "#154734", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/261", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/261", apiSchedule: "sports/basketball/mens-college-basketball/teams/261/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/261/roster", teamId: "261", espnAbbr: "UVM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-umbc", name: "UMBC Retrievers", shortName: "UMBC", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2378.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "America East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2378", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2378", apiSchedule: "sports/basketball/mens-college-basketball/teams/2378/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2378/roster", teamId: "2378", espnAbbr: "UMBC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-utsa", name: "UTSA Roadrunners", shortName: "UTSA", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2636.png", accent: "#002A5C", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2636", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2636", apiSchedule: "sports/basketball/mens-college-basketball/teams/2636/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2636/roster", teamId: "2636", espnAbbr: "UTSA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ecu", name: "East Carolina Pirates", shortName: "East Carolina", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/151.png", accent: "#582c83", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/151", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/151", apiSchedule: "sports/basketball/mens-college-basketball/teams/151/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/151/roster", teamId: "151", espnAbbr: "ECU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-rice", name: "Rice Owls", shortName: "Rice", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/242.png", accent: "#00205b", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/242", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/242", apiSchedule: "sports/basketball/mens-college-basketball/teams/242/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/242/roster", teamId: "242", espnAbbr: "RICE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tuln", name: "Tulane Green Wave", shortName: "Tulane", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2655.png", accent: "#006547", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2655", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2655", apiSchedule: "sports/basketball/mens-college-basketball/teams/2655/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2655/roster", teamId: "2655", espnAbbr: "TULN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tem", name: "Temple Owls", shortName: "Temple", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/218.png", accent: "#a41e35", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/218", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/218", apiSchedule: "sports/basketball/mens-college-basketball/teams/218/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/218/roster", teamId: "218", espnAbbr: "TEM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mem", name: "Memphis Tigers", shortName: "Memphis", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/235.png", accent: "#004991", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/235", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/235", apiSchedule: "sports/basketball/mens-college-basketball/teams/235/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/235/roster", teamId: "235", espnAbbr: "MEM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unt", name: "North Texas Mean Green", shortName: "North Texas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/249.png", accent: "#068f33", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/249", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/249", apiSchedule: "sports/basketball/mens-college-basketball/teams/249/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/249/roster", teamId: "249", espnAbbr: "UNT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fau", name: "Florida Atlantic Owls", shortName: "FAU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2226.png", accent: "#00447c", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2226", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2226", apiSchedule: "sports/basketball/mens-college-basketball/teams/2226/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2226/roster", teamId: "2226", espnAbbr: "FAU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-clt", name: "Charlotte 49ers", shortName: "Charlotte", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2429.png", accent: "#ffffff", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2429", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2429", apiSchedule: "sports/basketball/mens-college-basketball/teams/2429/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2429/roster", teamId: "2429", espnAbbr: "CLT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uab", name: "UAB Blazers", shortName: "UAB", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/5.png", accent: "#1a5632", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/5", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/5", apiSchedule: "sports/basketball/mens-college-basketball/teams/5/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/5/roster", teamId: "5", espnAbbr: "UAB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tlsa", name: "Tulsa Golden Hurricane", shortName: "Tulsa", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/202.png", accent: "#003595", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/202", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/202", apiSchedule: "sports/basketball/mens-college-basketball/teams/202/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/202/roster", teamId: "202", espnAbbr: "TLSA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wich", name: "Wichita State Shockers", shortName: "Wichita St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2724.png", accent: "#0d0a03", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2724", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2724", apiSchedule: "sports/basketball/mens-college-basketball/teams/2724/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2724/roster", teamId: "2724", espnAbbr: "WICH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-usf", name: "South Florida Bulls", shortName: "South Florida", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/58.png", accent: "#006747", league: "NCAAM", leagueTag: "NCAAM", conference: "American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/58", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/58", apiSchedule: "sports/basketball/mens-college-basketball/teams/58/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/58/roster", teamId: "58", espnAbbr: "USF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-una", name: "North Alabama Lions", shortName: "North Alabama", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2453.png", accent: "#663399", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2453", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2453", apiSchedule: "sports/basketball/mens-college-basketball/teams/2453/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2453/roster", teamId: "2453", espnAbbr: "UNA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unf", name: "North Florida Ospreys", shortName: "North Florida", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2454.png", accent: "#004B8D", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2454", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2454", apiSchedule: "sports/basketball/mens-college-basketball/teams/2454/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2454/roster", teamId: "2454", espnAbbr: "UNF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bell", name: "Bellarmine Knights", shortName: "Bellarmine", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/91.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/91", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/91", apiSchedule: "sports/basketball/mens-college-basketball/teams/91/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/91/roster", teamId: "91", espnAbbr: "BELL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-jax", name: "Jacksonville Dolphins", shortName: "Jacksonville", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/294.png", accent: "#00523e", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/294", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/294", apiSchedule: "sports/basketball/mens-college-basketball/teams/294/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/294/roster", teamId: "294", espnAbbr: "JAX", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-stet", name: "Stetson Hatters", shortName: "Stetson", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/56.png", accent: "#0a5640", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/56", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/56", apiSchedule: "sports/basketball/mens-college-basketball/teams/56/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/56/roster", teamId: "56", espnAbbr: "STET", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-eku", name: "Eastern Kentucky Colonels", shortName: "E Kentucky", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2198.png", accent: "#660819", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2198", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2198", apiSchedule: "sports/basketball/mens-college-basketball/teams/2198/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2198/roster", teamId: "2198", espnAbbr: "EKU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fgcu", name: "Florida Gulf Coast Eagles", shortName: "FGCU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/526.png", accent: "#00885a", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/526", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/526", apiSchedule: "sports/basketball/mens-college-basketball/teams/526/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/526/roster", teamId: "526", espnAbbr: "FGCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wga", name: "West Georgia Wolves", shortName: "West Georgia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2698.png", accent: "#0033a1", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2698", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2698", apiSchedule: "sports/basketball/mens-college-basketball/teams/2698/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2698/roster", teamId: "2698", espnAbbr: "WGA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lip", name: "Lipscomb Bisons", shortName: "Lipscomb", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/288.png", accent: "#20366C", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/288", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/288", apiSchedule: "sports/basketball/mens-college-basketball/teams/288/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/288/roster", teamId: "288", espnAbbr: "LIP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-quc", name: "Queens University Royals", shortName: "Queens", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2511.png", accent: "#333333", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2511", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2511", apiSchedule: "sports/basketball/mens-college-basketball/teams/2511/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2511/roster", teamId: "2511", espnAbbr: "QUC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-apsu", name: "Austin Peay Governors", shortName: "Austin Peay", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2046.png", accent: "#8e0b0b", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2046", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2046", apiSchedule: "sports/basketball/mens-college-basketball/teams/2046/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2046/roster", teamId: "2046", espnAbbr: "APSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cark", name: "Central Arkansas Bears", shortName: "C Arkansas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2110.png", accent: "#a7a9ac", league: "NCAAM", leagueTag: "NCAAM", conference: "ASUN Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2110", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2110", apiSchedule: "sports/basketball/mens-college-basketball/teams/2110/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2110/roster", teamId: "2110", espnAbbr: "CARK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sbu", name: "St. Bonaventure Bonnies", shortName: "St Bonaventure", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/179.png", accent: "#70261D", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/179", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/179", apiSchedule: "sports/basketball/mens-college-basketball/teams/179/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/179/roster", teamId: "179", espnAbbr: "SBU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-luc", name: "Loyola Chicago Ramblers", shortName: "Loyola Chicago", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2350.png", accent: "#9d1244", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2350", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2350", apiSchedule: "sports/basketball/mens-college-basketball/teams/2350/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2350/roster", teamId: "2350", espnAbbr: "LUC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-rich", name: "Richmond Spiders", shortName: "Richmond", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/257.png", accent: "#9e0712", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/257", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/257", apiSchedule: "sports/basketball/mens-college-basketball/teams/257/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/257/roster", teamId: "257", espnAbbr: "RICH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-las", name: "La Salle Explorers", shortName: "La Salle", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2325.png", accent: "#003356", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2325", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2325", apiSchedule: "sports/basketball/mens-college-basketball/teams/2325/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2325/roster", teamId: "2325", espnAbbr: "LAS", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uri", name: "Rhode Island Rams", shortName: "Rhode Island", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/227.png", accent: "#091f3f", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/227", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/227", apiSchedule: "sports/basketball/mens-college-basketball/teams/227/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/227/roster", teamId: "227", espnAbbr: "URI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gw", name: "George Washington Revolutionaries", shortName: "G Washington", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/45.png", accent: "#002843", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/45", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/45", apiSchedule: "sports/basketball/mens-college-basketball/teams/45/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/45/roster", teamId: "45", espnAbbr: "GW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-for", name: "Fordham Rams", shortName: "Fordham", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2230.png", accent: "#830032", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2230", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2230", apiSchedule: "sports/basketball/mens-college-basketball/teams/2230/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2230/roster", teamId: "2230", espnAbbr: "FOR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-duq", name: "Duquesne Dukes", shortName: "Duquesne", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2184.png", accent: "#002D62", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2184", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2184", apiSchedule: "sports/basketball/mens-college-basketball/teams/2184/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2184/roster", teamId: "2184", espnAbbr: "DUQ", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-dav", name: "Davidson Wildcats", shortName: "Davidson", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2166.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2166", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2166", apiSchedule: "sports/basketball/mens-college-basketball/teams/2166/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2166/roster", teamId: "2166", espnAbbr: "DAV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gmu", name: "George Mason Patriots", shortName: "George Mason", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2244.png", accent: "#016600", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2244", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2244", apiSchedule: "sports/basketball/mens-college-basketball/teams/2244/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2244/roster", teamId: "2244", espnAbbr: "GMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-day", name: "Dayton Flyers", shortName: "Dayton", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2168.png", accent: "#004B8D", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2168", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2168", apiSchedule: "sports/basketball/mens-college-basketball/teams/2168/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2168/roster", teamId: "2168", espnAbbr: "DAY", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-joes", name: "Saint Joseph's Hawks", shortName: "Saint Joseph's", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2603.png", accent: "#9e1b32", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2603", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2603", apiSchedule: "sports/basketball/mens-college-basketball/teams/2603/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2603/roster", teamId: "2603", espnAbbr: "JOES", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-slu", name: "Saint Louis Billikens", shortName: "Saint Louis", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/139.png", accent: "#00539C", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/139", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/139", apiSchedule: "sports/basketball/mens-college-basketball/teams/139/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/139/roster", teamId: "139", espnAbbr: "SLU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-vcu", name: "VCU Rams", shortName: "VCU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2670.png", accent: "#ffaf00", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic 10 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2670", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2670", apiSchedule: "sports/basketball/mens-college-basketball/teams/2670/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2670/roster", teamId: "2670", espnAbbr: "VCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gt", name: "Georgia Tech Yellow Jackets", shortName: "Georgia Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/59.png", accent: "#b3a369", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/59", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/59", apiSchedule: "sports/basketball/mens-college-basketball/teams/59/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/59/roster", teamId: "59", espnAbbr: "GT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nd", name: "Notre Dame Fighting Irish", shortName: "Notre Dame", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/87.png", accent: "#062340", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/87", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/87", apiSchedule: "sports/basketball/mens-college-basketball/teams/87/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/87/roster", teamId: "87", espnAbbr: "ND", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bc", name: "Boston College Eagles", shortName: "Boston College", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/103.png", accent: "#8c2232", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/103", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/103", apiSchedule: "sports/basketball/mens-college-basketball/teams/103/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/103/roster", teamId: "103", espnAbbr: "BC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-pitt", name: "Pittsburgh Panthers", shortName: "Pitt", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/221.png", accent: "#003594", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/221", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/221", apiSchedule: "sports/basketball/mens-college-basketball/teams/221/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/221/roster", teamId: "221", espnAbbr: "PITT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-syr", name: "Syracuse Orange", shortName: "Syracuse", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/183.png", accent: "#000e54", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/183", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/183", apiSchedule: "sports/basketball/mens-college-basketball/teams/183/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/183/roster", teamId: "183", espnAbbr: "SYR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wake", name: "Wake Forest Demon Deacons", shortName: "Wake Forest", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/154.png", accent: "#ceb888", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/154", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/154", apiSchedule: "sports/basketball/mens-college-basketball/teams/154/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/154/roster", teamId: "154", espnAbbr: "WAKE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-smu", name: "SMU Mustangs", shortName: "SMU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2567.png", accent: "#354ca1", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2567", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2567", apiSchedule: "sports/basketball/mens-college-basketball/teams/2567/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2567/roster", teamId: "2567", espnAbbr: "SMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-vt", name: "Virginia Tech Hokies", shortName: "Virginia Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/259.png", accent: "#6a2c3e", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/259", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/259", apiSchedule: "sports/basketball/mens-college-basketball/teams/259/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/259/roster", teamId: "259", espnAbbr: "VT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cal", name: "California Golden Bears", shortName: "California", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/25.png", accent: "#041e42", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/25", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/25", apiSchedule: "sports/basketball/mens-college-basketball/teams/25/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/25/roster", teamId: "25", espnAbbr: "CAL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-stan", name: "Stanford Cardinal", shortName: "Stanford", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/24.png", accent: "#8c1515", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/24", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/24", apiSchedule: "sports/basketball/mens-college-basketball/teams/24/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/24/roster", teamId: "24", espnAbbr: "STAN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ncsu", name: "NC State Wolfpack", shortName: "NC State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/152.png", accent: "#cc0000", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/152", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/152", apiSchedule: "sports/basketball/mens-college-basketball/teams/152/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/152/roster", teamId: "152", espnAbbr: "NCSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fsu", name: "Florida State Seminoles", shortName: "Florida St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/52.png", accent: "#782f40", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/52", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/52", apiSchedule: "sports/basketball/mens-college-basketball/teams/52/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/52/roster", teamId: "52", espnAbbr: "FSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lou", name: "Louisville Cardinals", shortName: "Louisville", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/97.png", accent: "#c9001f", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/97", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/97", apiSchedule: "sports/basketball/mens-college-basketball/teams/97/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/97/roster", teamId: "97", espnAbbr: "LOU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unc", name: "North Carolina Tar Heels", shortName: "North Carolina", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/153.png", accent: "#7bafd4", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/153", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/153", apiSchedule: "sports/basketball/mens-college-basketball/teams/153/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/153/roster", teamId: "153", espnAbbr: "UNC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-clem", name: "Clemson Tigers", shortName: "Clemson", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/228.png", accent: "#f56600", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/228", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/228", apiSchedule: "sports/basketball/mens-college-basketball/teams/228/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/228/roster", teamId: "228", espnAbbr: "CLEM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mia", name: "Miami Hurricanes", shortName: "Miami", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2390.png", accent: "#005030", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2390", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2390", apiSchedule: "sports/basketball/mens-college-basketball/teams/2390/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2390/roster", teamId: "2390", espnAbbr: "MIA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uva", name: "Virginia Cavaliers", shortName: "Virginia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/258.png", accent: "#f84c1e", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/258", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/258", apiSchedule: "sports/basketball/mens-college-basketball/teams/258/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/258/roster", teamId: "258", espnAbbr: "UVA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-duke", name: "Duke Blue Devils", shortName: "Duke", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/150.png", accent: "#00539b", league: "NCAAM", leagueTag: "NCAAM", conference: "Atlantic Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/150", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/150", apiSchedule: "sports/basketball/mens-college-basketball/teams/150/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/150/roster", teamId: "150", espnAbbr: "DUKE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-utah", name: "Utah Utes", shortName: "Utah", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/254.png", accent: "#be0000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/254", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/254", apiSchedule: "sports/basketball/mens-college-basketball/teams/254/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/254/roster", teamId: "254", espnAbbr: "UTAH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ksu", name: "Kansas State Wildcats", shortName: "Kansas St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2306.png", accent: "#3c0969", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2306", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2306", apiSchedule: "sports/basketball/mens-college-basketball/teams/2306/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2306/roster", teamId: "2306", espnAbbr: "KSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-okst", name: "Oklahoma State Cowboys", shortName: "Oklahoma St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/197.png", accent: "#fe5c00", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/197", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/197", apiSchedule: "sports/basketball/mens-college-basketball/teams/197/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/197/roster", teamId: "197", espnAbbr: "OKST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bay", name: "Baylor Bears", shortName: "Baylor", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/239.png", accent: "#154734", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/239", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/239", apiSchedule: "sports/basketball/mens-college-basketball/teams/239/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/239/roster", teamId: "239", espnAbbr: "BAY", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-colo", name: "Colorado Buffaloes", shortName: "Colorado", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/38.png", accent: "#cfb87c", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/38", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/38", apiSchedule: "sports/basketball/mens-college-basketball/teams/38/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/38/roster", teamId: "38", espnAbbr: "COLO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-asu", name: "Arizona State Sun Devils", shortName: "Arizona St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/9.png", accent: "#ffc627", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/9", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/9", apiSchedule: "sports/basketball/mens-college-basketball/teams/9/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/9/roster", teamId: "9", espnAbbr: "ASU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-byu", name: "BYU Cougars", shortName: "BYU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/252.png", accent: "#0047ba", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/252", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/252", apiSchedule: "sports/basketball/mens-college-basketball/teams/252/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/252/roster", teamId: "252", espnAbbr: "BYU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ucf", name: "UCF Knights", shortName: "UCF", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2116.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2116", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2116", apiSchedule: "sports/basketball/mens-college-basketball/teams/2116/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2116/roster", teamId: "2116", espnAbbr: "UCF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wvu", name: "West Virginia Mountaineers", shortName: "West Virginia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/277.png", accent: "#eaaa00", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/277", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/277", apiSchedule: "sports/basketball/mens-college-basketball/teams/277/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/277/roster", teamId: "277", espnAbbr: "WVU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cin", name: "Cincinnati Bearcats", shortName: "Cincinnati", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2132.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2132", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2132", apiSchedule: "sports/basketball/mens-college-basketball/teams/2132/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2132/roster", teamId: "2132", espnAbbr: "CIN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tcu", name: "TCU Horned Frogs", shortName: "TCU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2628.png", accent: "#4d1979", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2628", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2628", apiSchedule: "sports/basketball/mens-college-basketball/teams/2628/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2628/roster", teamId: "2628", espnAbbr: "TCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-isu", name: "Iowa State Cyclones", shortName: "Iowa State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/66.png", accent: "#ae192d", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/66", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/66", apiSchedule: "sports/basketball/mens-college-basketball/teams/66/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/66/roster", teamId: "66", espnAbbr: "ISU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ku", name: "Kansas Jayhawks", shortName: "Kansas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2305.png", accent: "#0051ba", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2305", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2305", apiSchedule: "sports/basketball/mens-college-basketball/teams/2305/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2305/roster", teamId: "2305", espnAbbr: "KU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ttu", name: "Texas Tech Red Raiders", shortName: "Texas Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2641.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2641", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2641", apiSchedule: "sports/basketball/mens-college-basketball/teams/2641/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2641/roster", teamId: "2641", espnAbbr: "TTU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-hou", name: "Houston Cougars", shortName: "Houston", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/248.png", accent: "#c8102e", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/248", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/248", apiSchedule: "sports/basketball/mens-college-basketball/teams/248/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/248/roster", teamId: "248", espnAbbr: "HOU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ariz", name: "Arizona Wildcats", shortName: "Arizona", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/12.png", accent: "#cc0033", league: "NCAAM", leagueTag: "NCAAM", conference: "Big 12 Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/12", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/12", apiSchedule: "sports/basketball/mens-college-basketball/teams/12/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/12/roster", teamId: "12", espnAbbr: "ARIZ", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gtwn", name: "Georgetown Hoyas", shortName: "Georgetown", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/46.png", accent: "#110E42", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/46", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/46", apiSchedule: "sports/basketball/mens-college-basketball/teams/46/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/46/roster", teamId: "46", espnAbbr: "GTWN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-xav", name: "Xavier Musketeers", shortName: "Xavier", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2752.png", accent: "#21304e", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2752", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2752", apiSchedule: "sports/basketball/mens-college-basketball/teams/2752/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2752/roster", teamId: "2752", espnAbbr: "XAV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-but", name: "Butler Bulldogs", shortName: "Butler", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2086.png", accent: "#0d1361", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2086", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2086", apiSchedule: "sports/basketball/mens-college-basketball/teams/2086/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2086/roster", teamId: "2086", espnAbbr: "BUT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-prov", name: "Providence Friars", shortName: "Providence", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2507.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2507", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2507", apiSchedule: "sports/basketball/mens-college-basketball/teams/2507/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2507/roster", teamId: "2507", espnAbbr: "PROV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-marq", name: "Marquette Golden Eagles", shortName: "Marquette", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/269.png", accent: "#003366", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/269", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/269", apiSchedule: "sports/basketball/mens-college-basketball/teams/269/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/269/roster", teamId: "269", espnAbbr: "MARQ", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-dep", name: "DePaul Blue Demons", shortName: "DePaul", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/305.png", accent: "#2d649c", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/305", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/305", apiSchedule: "sports/basketball/mens-college-basketball/teams/305/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/305/roster", teamId: "305", espnAbbr: "DEP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-crei", name: "Creighton Bluejays", shortName: "Creighton", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/156.png", accent: "#005ca9", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/156", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/156", apiSchedule: "sports/basketball/mens-college-basketball/teams/156/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/156/roster", teamId: "156", espnAbbr: "CREI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-hall", name: "Seton Hall Pirates", shortName: "Seton Hall", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2550.png", accent: "#0857B1", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2550", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2550", apiSchedule: "sports/basketball/mens-college-basketball/teams/2550/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2550/roster", teamId: "2550", espnAbbr: "HALL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-vill", name: "Villanova Wildcats", shortName: "Villanova", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/222.png", accent: "#00205b", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/222", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/222", apiSchedule: "sports/basketball/mens-college-basketball/teams/222/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/222/roster", teamId: "222", espnAbbr: "VILL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-conn", name: "UConn Huskies", shortName: "UConn", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/41.png", accent: "#0c2340", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/41", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/41", apiSchedule: "sports/basketball/mens-college-basketball/teams/41/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/41/roster", teamId: "41", espnAbbr: "CONN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sju", name: "St. John's Red Storm", shortName: "St John's", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2599.png", accent: "#d10000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big East Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2599", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2599", apiSchedule: "sports/basketball/mens-college-basketball/teams/2599/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2599/roster", teamId: "2599", espnAbbr: "SJU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nau", name: "Northern Arizona Lumberjacks", shortName: "N Arizona", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2464.png", accent: "#003976", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2464", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2464", apiSchedule: "sports/basketball/mens-college-basketball/teams/2464/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2464/roster", teamId: "2464", espnAbbr: "NAU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-idst", name: "Idaho State Bengals", shortName: "Idaho St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/304.png", accent: "#ef8c00", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/304", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/304", apiSchedule: "sports/basketball/mens-college-basketball/teams/304/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/304/roster", teamId: "304", espnAbbr: "IDST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sac", name: "Sacramento State Hornets", shortName: "Sacramento St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/16.png", accent: "#00573C", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/16", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/16", apiSchedule: "sports/basketball/mens-college-basketball/teams/16/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/16/roster", teamId: "16", espnAbbr: "SAC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-idho", name: "Idaho Vandals", shortName: "Idaho", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/70.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/70", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/70", apiSchedule: "sports/basketball/mens-college-basketball/teams/70/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/70/roster", teamId: "70", espnAbbr: "IDHO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unco", name: "Northern Colorado Bears", shortName: "N Colorado", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2458.png", accent: "#13558D", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2458", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2458", apiSchedule: "sports/basketball/mens-college-basketball/teams/2458/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2458/roster", teamId: "2458", espnAbbr: "UNCO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mont", name: "Montana Grizzlies", shortName: "Montana", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/149.png", accent: "#751D4A", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/149", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/149", apiSchedule: "sports/basketball/mens-college-basketball/teams/149/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/149/roster", teamId: "149", espnAbbr: "MONT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-web", name: "Weber State Wildcats", shortName: "Weber St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2692.png", accent: "#18005a", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2692", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2692", apiSchedule: "sports/basketball/mens-college-basketball/teams/2692/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2692/roster", teamId: "2692", espnAbbr: "WEB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ewu", name: "Eastern Washington Eagles", shortName: "E Washington", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/331.png", accent: "#a10022", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/331", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/331", apiSchedule: "sports/basketball/mens-college-basketball/teams/331/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/331/roster", teamId: "331", espnAbbr: "EWU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mtst", name: "Montana State Bobcats", shortName: "Montana St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/147.png", accent: "#00205c", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/147", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/147", apiSchedule: "sports/basketball/mens-college-basketball/teams/147/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/147/roster", teamId: "147", espnAbbr: "MTST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-prst", name: "Portland State Vikings", shortName: "Portland St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2502.png", accent: "#00311e", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Sky Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2502", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2502", apiSchedule: "sports/basketball/mens-college-basketball/teams/2502/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2502/roster", teamId: "2502", espnAbbr: "PRST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gweb", name: "Gardner-Webb Runnin' Bulldogs", shortName: "Gardner-Webb", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2241.png", accent: "#c12535", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2241", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2241", apiSchedule: "sports/basketball/mens-college-basketball/teams/2241/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2241/roster", teamId: "2241", espnAbbr: "GWEB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-upst", name: "South Carolina Upstate Spartans", shortName: "SC Upstate", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2908.png", accent: "#008545", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2908", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2908", apiSchedule: "sports/basketball/mens-college-basketball/teams/2908/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2908/roster", teamId: "2908", espnAbbr: "UPST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-chso", name: "Charleston Southern Buccaneers", shortName: "Charleston So", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2127.png", accent: "#2e3192", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2127", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2127", apiSchedule: "sports/basketball/mens-college-basketball/teams/2127/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2127/roster", teamId: "2127", espnAbbr: "CHSO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-pres", name: "Presbyterian Blue Hose", shortName: "Presbyterian", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2506.png", accent: "#194896", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2506", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2506", apiSchedule: "sports/basketball/mens-college-basketball/teams/2506/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2506/roster", teamId: "2506", espnAbbr: "PRES", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-long", name: "Longwood Lancers", shortName: "Longwood", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2344.png", accent: "#003273", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2344", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2344", apiSchedule: "sports/basketball/mens-college-basketball/teams/2344/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2344/roster", teamId: "2344", espnAbbr: "LONG", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unca", name: "UNC Asheville Bulldogs", shortName: "UNC Asheville", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2427.png", accent: "#003da5", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2427", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2427", apiSchedule: "sports/basketball/mens-college-basketball/teams/2427/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2427/roster", teamId: "2427", espnAbbr: "UNCA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-rad", name: "Radford Highlanders", shortName: "Radford", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2515.png", accent: "#BC1515", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2515", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2515", apiSchedule: "sports/basketball/mens-college-basketball/teams/2515/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2515/roster", teamId: "2515", espnAbbr: "RAD", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-win", name: "Winthrop Eagles", shortName: "Winthrop", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2737.png", accent: "#9e0b0e", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2737", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2737", apiSchedule: "sports/basketball/mens-college-basketball/teams/2737/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2737/roster", teamId: "2737", espnAbbr: "WIN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-hpu", name: "High Point Panthers", shortName: "High Point", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2272.png", accent: "#b0b7bc", league: "NCAAM", leagueTag: "NCAAM", conference: "Big South Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2272", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2272", apiSchedule: "sports/basketball/mens-college-basketball/teams/2272/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2272/roster", teamId: "2272", espnAbbr: "HPU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-psu", name: "Penn State Nittany Lions", shortName: "Penn State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/213.png", accent: "#061440", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/213", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/213", apiSchedule: "sports/basketball/mens-college-basketball/teams/213/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/213/roster", teamId: "213", espnAbbr: "PSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-md", name: "Maryland Terrapins", shortName: "Maryland", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/120.png", accent: "#ce1126", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/120", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/120", apiSchedule: "sports/basketball/mens-college-basketball/teams/120/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/120/roster", teamId: "120", espnAbbr: "MD", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nu", name: "Northwestern Wildcats", shortName: "Northwestern", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/77.png", accent: "#492f92", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/77", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/77", apiSchedule: "sports/basketball/mens-college-basketball/teams/77/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/77/roster", teamId: "77", espnAbbr: "NU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ore", name: "Oregon Ducks", shortName: "Oregon", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2483.png", accent: "#007030", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2483", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2483", apiSchedule: "sports/basketball/mens-college-basketball/teams/2483/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2483/roster", teamId: "2483", espnAbbr: "ORE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-rutg", name: "Rutgers Scarlet Knights", shortName: "Rutgers", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/164.png", accent: "#ce0e2d", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/164", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/164", apiSchedule: "sports/basketball/mens-college-basketball/teams/164/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/164/roster", teamId: "164", espnAbbr: "RUTG", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-usc", name: "USC Trojans", shortName: "USC", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/30.png", accent: "#9d2235", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/30", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/30", apiSchedule: "sports/basketball/mens-college-basketball/teams/30/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/30/roster", teamId: "30", espnAbbr: "USC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wash", name: "Washington Huskies", shortName: "Washington", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/264.png", accent: "#33006f", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/264", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/264", apiSchedule: "sports/basketball/mens-college-basketball/teams/264/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/264/roster", teamId: "264", espnAbbr: "WASH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-minn", name: "Minnesota Golden Gophers", shortName: "Minnesota", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/135.png", accent: "#5e0a2f", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/135", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/135", apiSchedule: "sports/basketball/mens-college-basketball/teams/135/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/135/roster", teamId: "135", espnAbbr: "MINN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-iu", name: "Indiana Hoosiers", shortName: "Indiana", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/84.png", accent: "#970310", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/84", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/84", apiSchedule: "sports/basketball/mens-college-basketball/teams/84/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/84/roster", teamId: "84", espnAbbr: "IU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-iowa", name: "Iowa Hawkeyes", shortName: "Iowa", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2294.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2294", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2294", apiSchedule: "sports/basketball/mens-college-basketball/teams/2294/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2294/roster", teamId: "2294", espnAbbr: "IOWA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-osu", name: "Ohio State Buckeyes", shortName: "Ohio State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png", accent: "#ba0c2f", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/194", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/194", apiSchedule: "sports/basketball/mens-college-basketball/teams/194/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/194/roster", teamId: "194", espnAbbr: "OSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-pur", name: "Purdue Boilermakers", shortName: "Purdue", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2509.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2509", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2509", apiSchedule: "sports/basketball/mens-college-basketball/teams/2509/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2509/roster", teamId: "2509", espnAbbr: "PUR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ucla", name: "UCLA Bruins", shortName: "UCLA", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/26.png", accent: "#2774ae", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/26", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/26", apiSchedule: "sports/basketball/mens-college-basketball/teams/26/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/26/roster", teamId: "26", espnAbbr: "UCLA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wis", name: "Wisconsin Badgers", shortName: "Wisconsin", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/275.png", accent: "#a00000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/275", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/275", apiSchedule: "sports/basketball/mens-college-basketball/teams/275/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/275/roster", teamId: "275", espnAbbr: "WIS", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-neb", name: "Nebraska Cornhuskers", shortName: "Nebraska", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/158.png", accent: "#e31937", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/158", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/158", apiSchedule: "sports/basketball/mens-college-basketball/teams/158/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/158/roster", teamId: "158", espnAbbr: "NEB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-msu", name: "Michigan State Spartans", shortName: "Michigan St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/127.png", accent: "#173f35", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/127", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/127", apiSchedule: "sports/basketball/mens-college-basketball/teams/127/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/127/roster", teamId: "127", espnAbbr: "MSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ill", name: "Illinois Fighting Illini", shortName: "Illinois", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/356.png", accent: "#ff5f05", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/356", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/356", apiSchedule: "sports/basketball/mens-college-basketball/teams/356/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/356/roster", teamId: "356", espnAbbr: "ILL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mich", name: "Michigan Wolverines", shortName: "Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/130.png", accent: "#00274c", league: "NCAAM", leagueTag: "NCAAM", conference: "Big Ten Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/130", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/130", apiSchedule: "sports/basketball/mens-college-basketball/teams/130/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/130/roster", teamId: "130", espnAbbr: "MICH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-csub", name: "Cal State Bakersfield Roadrunners", shortName: "Bakersfield", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2934.png", accent: "#003BAB", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2934", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2934", apiSchedule: "sports/basketball/mens-college-basketball/teams/2934/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2934/roster", teamId: "2934", espnAbbr: "CSUB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ucr", name: "UC Riverside Highlanders", shortName: "UC Riverside", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/27.png", accent: "#14234F", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/27", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/27", apiSchedule: "sports/basketball/mens-college-basketball/teams/27/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/27/roster", teamId: "27", espnAbbr: "UCR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lbsu", name: "Long Beach State Beach", shortName: "Long Beach St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/299.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/299", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/299", apiSchedule: "sports/basketball/mens-college-basketball/teams/299/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/299/roster", teamId: "299", espnAbbr: "LBSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cp", name: "Cal Poly Mustangs", shortName: "Cal Poly", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/13.png", accent: "#1E4D2B", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/13", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/13", apiSchedule: "sports/basketball/mens-college-basketball/teams/13/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/13/roster", teamId: "13", espnAbbr: "CP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ucd", name: "UC Davis Aggies", shortName: "UC Davis", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/302.png", accent: "#002855", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/302", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/302", apiSchedule: "sports/basketball/mens-college-basketball/teams/302/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/302/roster", teamId: "302", espnAbbr: "UCD", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ucsb", name: "UC Santa Barbara Gauchos", shortName: "Santa Barbara", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2540.png", accent: "#1e1840", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2540", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2540", apiSchedule: "sports/basketball/mens-college-basketball/teams/2540/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2540/roster", teamId: "2540", espnAbbr: "UCSB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ucsd", name: "UC San Diego Tritons", shortName: "UC San Diego", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/28.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/28", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/28", apiSchedule: "sports/basketball/mens-college-basketball/teams/28/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/28/roster", teamId: "28", espnAbbr: "UCSD", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-csun", name: "Cal State Northridge Matadors", shortName: "CSU Northridge", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2463.png", accent: "#b50000", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2463", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2463", apiSchedule: "sports/basketball/mens-college-basketball/teams/2463/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2463/roster", teamId: "2463", espnAbbr: "CSUN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-csuf", name: "Cal State Fullerton Titans", shortName: "Fullerton", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2239.png", accent: "#003767", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2239", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2239", apiSchedule: "sports/basketball/mens-college-basketball/teams/2239/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2239/roster", teamId: "2239", espnAbbr: "CSUF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-haw", name: "Hawai'i Rainbow Warriors", shortName: "Hawai'i", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/62.png", accent: "#005737", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/62", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/62", apiSchedule: "sports/basketball/mens-college-basketball/teams/62/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/62/roster", teamId: "62", espnAbbr: "HAW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uci", name: "UC Irvine Anteaters", shortName: "UC Irvine", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/300.png", accent: "#002B5C", league: "NCAAM", leagueTag: "NCAAM", conference: "Big West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/300", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/300", apiSchedule: "sports/basketball/mens-college-basketball/teams/300/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/300/roster", teamId: "300", espnAbbr: "UCI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ne", name: "Northeastern Huskies", shortName: "Northeastern", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/111.png", accent: "#CC0001", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/111", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/111", apiSchedule: "sports/basketball/mens-college-basketball/teams/111/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/111/roster", teamId: "111", espnAbbr: "NE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ncat", name: "North Carolina A&T Aggies", shortName: "NC A&T", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2448.png", accent: "#0505aa", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2448", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2448", apiSchedule: "sports/basketball/mens-college-basketball/teams/2448/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2448/roster", teamId: "2448", espnAbbr: "NCAT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-elon", name: "Elon Phoenix", shortName: "Elon", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2210.png", accent: "#020303", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2210", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2210", apiSchedule: "sports/basketball/mens-college-basketball/teams/2210/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2210/roster", teamId: "2210", espnAbbr: "ELON", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-hamp", name: "Hampton Pirates", shortName: "Hampton", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2261.png", accent: "#0067AC", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2261", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2261", apiSchedule: "sports/basketball/mens-college-basketball/teams/2261/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2261/roster", teamId: "2261", espnAbbr: "HAMP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cam", name: "Campbell Fighting Camels", shortName: "Campbell", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2097.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2097", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2097", apiSchedule: "sports/basketball/mens-college-basketball/teams/2097/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2097/roster", teamId: "2097", espnAbbr: "CAM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tow", name: "Towson Tigers", shortName: "Towson", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/119.png", accent: "#FFC229", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/119", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/119", apiSchedule: "sports/basketball/mens-college-basketball/teams/119/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/119/roster", teamId: "119", espnAbbr: "TOW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-stbk", name: "Stony Brook Seawolves", shortName: "Stony Brook", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2619.png", accent: "#990000", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2619", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2619", apiSchedule: "sports/basketball/mens-college-basketball/teams/2619/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2619/roster", teamId: "2619", espnAbbr: "STBK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-w&m", name: "William & Mary Tribe", shortName: "William & Mary", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2729.png", accent: "#115740", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2729", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2729", apiSchedule: "sports/basketball/mens-college-basketball/teams/2729/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2729/roster", teamId: "2729", espnAbbr: "W&M", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-drex", name: "Drexel Dragons", shortName: "Drexel", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2182.png", accent: "#020260", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2182", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2182", apiSchedule: "sports/basketball/mens-college-basketball/teams/2182/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2182/roster", teamId: "2182", espnAbbr: "DREX", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-monm", name: "Monmouth Hawks", shortName: "Monmouth", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2405.png", accent: "#051844", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2405", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2405", apiSchedule: "sports/basketball/mens-college-basketball/teams/2405/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2405/roster", teamId: "2405", espnAbbr: "MONM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-hof", name: "Hofstra Pride", shortName: "Hofstra", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2275.png", accent: "#003594", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2275", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2275", apiSchedule: "sports/basketball/mens-college-basketball/teams/2275/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2275/roster", teamId: "2275", espnAbbr: "HOF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cofc", name: "Charleston Cougars", shortName: "Charleston", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/232.png", accent: "#7a2531", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/232", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/232", apiSchedule: "sports/basketball/mens-college-basketball/teams/232/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/232/roster", teamId: "232", espnAbbr: "COFC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uncw", name: "UNC Wilmington Seahawks", shortName: "UNC Wilmington", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/350.png", accent: "#00665e", league: "NCAAM", leagueTag: "NCAAM", conference: "Coastal Athletic Association", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/350", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/350", apiSchedule: "sports/basketball/mens-college-basketball/teams/350/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/350/roster", teamId: "350", espnAbbr: "UNCW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-del", name: "Delaware Blue Hens", shortName: "Delaware", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/48.png", accent: "#00539f", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/48", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/48", apiSchedule: "sports/basketball/mens-college-basketball/teams/48/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/48/roster", teamId: "48", espnAbbr: "DEL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-utep", name: "UTEP Miners", shortName: "UTEP", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2638.png", accent: "#ff8200", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2638", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2638", apiSchedule: "sports/basketball/mens-college-basketball/teams/2638/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2638/roster", teamId: "2638", espnAbbr: "UTEP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nmsu", name: "New Mexico State Aggies", shortName: "New Mexico St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/166.png", accent: "#7e141b", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/166", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/166", apiSchedule: "sports/basketball/mens-college-basketball/teams/166/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/166/roster", teamId: "166", espnAbbr: "NMSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-most", name: "Missouri State Bears", shortName: "Missouri St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2623.png", accent: "#5F0000", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2623", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2623", apiSchedule: "sports/basketball/mens-college-basketball/teams/2623/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2623/roster", teamId: "2623", espnAbbr: "MOST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fiu", name: "Florida International Panthers", shortName: "FIU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2229.png", accent: "#091731", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2229", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2229", apiSchedule: "sports/basketball/mens-college-basketball/teams/2229/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2229/roster", teamId: "2229", espnAbbr: "FIU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-kenn", name: "Kennesaw State Owls", shortName: "Kennesaw St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/338.png", accent: "#fdbb30", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/338", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/338", apiSchedule: "sports/basketball/mens-college-basketball/teams/338/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/338/roster", teamId: "338", espnAbbr: "KENN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-jxst", name: "Jacksonville State Gamecocks", shortName: "Jax State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/55.png", accent: "#cc0000", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/55", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/55", apiSchedule: "sports/basketball/mens-college-basketball/teams/55/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/55/roster", teamId: "55", espnAbbr: "JXST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lt", name: "Louisiana Tech Bulldogs", shortName: "Louisiana Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2348.png", accent: "#002d65", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2348", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2348", apiSchedule: "sports/basketball/mens-college-basketball/teams/2348/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2348/roster", teamId: "2348", espnAbbr: "LT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wku", name: "Western Kentucky Hilltoppers", shortName: "Western KY", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/98.png", accent: "#e13a3e", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/98", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/98", apiSchedule: "sports/basketball/mens-college-basketball/teams/98/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/98/roster", teamId: "98", espnAbbr: "WKU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mtsu", name: "Middle Tennessee Blue Raiders", shortName: "MTSU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2393.png", accent: "#006db6", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2393", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2393", apiSchedule: "sports/basketball/mens-college-basketball/teams/2393/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2393/roster", teamId: "2393", espnAbbr: "MTSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-shsu", name: "Sam Houston Bearkats", shortName: "Sam Houston", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2534.png", accent: "#fe5000", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2534", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2534", apiSchedule: "sports/basketball/mens-college-basketball/teams/2534/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2534/roster", teamId: "2534", espnAbbr: "SHSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lib", name: "Liberty Flames", shortName: "Liberty", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2335.png", accent: "#071740", league: "NCAAM", leagueTag: "NCAAM", conference: "Conference USA", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2335", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2335", apiSchedule: "sports/basketball/mens-college-basketball/teams/2335/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2335/roster", teamId: "2335", espnAbbr: "LIB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-iuin", name: "IU Indianapolis Jaguars", shortName: "IU Indy", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/85.png", accent: "#A81F30", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/85", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/85", apiSchedule: "sports/basketball/mens-college-basketball/teams/85/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/85/roster", teamId: "85", espnAbbr: "IUIN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cle", name: "Cleveland State Vikings", shortName: "Cleveland St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/325.png", accent: "#006633", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/325", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/325", apiSchedule: "sports/basketball/mens-college-basketball/teams/325/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/325/roster", teamId: "325", espnAbbr: "CLE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ysu", name: "Youngstown State Penguins", shortName: "Youngstown St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2754.png", accent: "#E51935", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2754", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2754", apiSchedule: "sports/basketball/mens-college-basketball/teams/2754/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2754/roster", teamId: "2754", espnAbbr: "YSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-milw", name: "Milwaukee Panthers", shortName: "Milwaukee", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/270.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/270", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/270", apiSchedule: "sports/basketball/mens-college-basketball/teams/270/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/270/roster", teamId: "270", espnAbbr: "MILW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nku", name: "Northern Kentucky Norse", shortName: "N Kentucky", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/94.png", accent: "#ffc82e", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/94", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/94", apiSchedule: "sports/basketball/mens-college-basketball/teams/94/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/94/roster", teamId: "94", espnAbbr: "NKU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-pfw", name: "Purdue Fort Wayne Mastodons", shortName: "Purdue FW", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2870.png", accent: "#cfb991", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2870", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2870", apiSchedule: "sports/basketball/mens-college-basketball/teams/2870/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2870/roster", teamId: "2870", espnAbbr: "PFW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gb", name: "Green Bay Phoenix", shortName: "Green Bay", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2739.png", accent: "#006633", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2739", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2739", apiSchedule: "sports/basketball/mens-college-basketball/teams/2739/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2739/roster", teamId: "2739", espnAbbr: "GB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-detm", name: "Detroit Mercy Titans", shortName: "Detroit Mercy", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2174.png", accent: "#165b9e", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2174", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2174", apiSchedule: "sports/basketball/mens-college-basketball/teams/2174/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2174/roster", teamId: "2174", espnAbbr: "DETM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-oak", name: "Oakland Golden Grizzlies", shortName: "Oakland", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2473.png", accent: "#04091c", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2473", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2473", apiSchedule: "sports/basketball/mens-college-basketball/teams/2473/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2473/roster", teamId: "2473", espnAbbr: "OAK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-rmu", name: "Robert Morris Colonials", shortName: "Robert Morris", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2523.png", accent: "#00214D", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2523", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2523", apiSchedule: "sports/basketball/mens-college-basketball/teams/2523/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2523/roster", teamId: "2523", espnAbbr: "RMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wrst", name: "Wright State Raiders", shortName: "Wright St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2750.png", accent: "#cba052", league: "NCAAM", leagueTag: "NCAAM", conference: "Horizon League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2750", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2750", apiSchedule: "sports/basketball/mens-college-basketball/teams/2750/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2750/roster", teamId: "2750", espnAbbr: "WRST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-brwn", name: "Brown Bears", shortName: "Brown", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/225.png", accent: "#411e09", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/225", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/225", apiSchedule: "sports/basketball/mens-college-basketball/teams/225/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/225/roster", teamId: "225", espnAbbr: "BRWN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-colu", name: "Columbia Lions", shortName: "Columbia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/171.png", accent: "#7ba4db", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/171", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/171", apiSchedule: "sports/basketball/mens-college-basketball/teams/171/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/171/roster", teamId: "171", espnAbbr: "COLU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-dart", name: "Dartmouth Big Green", shortName: "Dartmouth", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/159.png", accent: "#005730", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/159", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/159", apiSchedule: "sports/basketball/mens-college-basketball/teams/159/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/159/roster", teamId: "159", espnAbbr: "DART", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-prin", name: "Princeton Tigers", shortName: "Princeton", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/163.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/163", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/163", apiSchedule: "sports/basketball/mens-college-basketball/teams/163/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/163/roster", teamId: "163", espnAbbr: "PRIN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cor", name: "Cornell Big Red", shortName: "Cornell", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/172.png", accent: "#b31b1b", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/172", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/172", apiSchedule: "sports/basketball/mens-college-basketball/teams/172/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/172/roster", teamId: "172", espnAbbr: "COR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-penn", name: "Pennsylvania Quakers", shortName: "Penn", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/219.png", accent: "#082A74", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/219", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/219", apiSchedule: "sports/basketball/mens-college-basketball/teams/219/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/219/roster", teamId: "219", espnAbbr: "PENN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-harv", name: "Harvard Crimson", shortName: "Harvard", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/108.png", accent: "#990000", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/108", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/108", apiSchedule: "sports/basketball/mens-college-basketball/teams/108/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/108/roster", teamId: "108", espnAbbr: "HARV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-yale", name: "Yale Bulldogs", shortName: "Yale", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/43.png", accent: "#004a81", league: "NCAAM", leagueTag: "NCAAM", conference: "Ivy League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/43", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/43", apiSchedule: "sports/basketball/mens-college-basketball/teams/43/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/43/roster", teamId: "43", espnAbbr: "YALE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-rid", name: "Rider Broncs", shortName: "Rider", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2520.png", accent: "#a80532", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2520", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2520", apiSchedule: "sports/basketball/mens-college-basketball/teams/2520/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2520/roster", teamId: "2520", espnAbbr: "RID", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-can", name: "Canisius Golden Griffins", shortName: "Canisius", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2099.png", accent: "#004a81", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2099", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2099", apiSchedule: "sports/basketball/mens-college-basketball/teams/2099/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2099/roster", teamId: "2099", espnAbbr: "CAN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nia", name: "Niagara Purple Eagles", shortName: "Niagara", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/315.png", accent: "#69207E", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/315", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/315", apiSchedule: "sports/basketball/mens-college-basketball/teams/315/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/315/roster", teamId: "315", espnAbbr: "NIA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-man", name: "Manhattan Jaspers", shortName: "Manhattan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2363.png", accent: "#4f8537", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2363", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2363", apiSchedule: "sports/basketball/mens-college-basketball/teams/2363/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2363/roster", teamId: "2363", espnAbbr: "MAN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-shu", name: "Sacred Heart Pioneers", shortName: "Sacred Heart", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2529.png", accent: "#a40001", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2529", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2529", apiSchedule: "sports/basketball/mens-college-basketball/teams/2529/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2529/roster", teamId: "2529", espnAbbr: "SHU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-iona", name: "Iona Gaels", shortName: "Iona", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/314.png", accent: "#6f2c3e", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/314", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/314", apiSchedule: "sports/basketball/mens-college-basketball/teams/314/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/314/roster", teamId: "314", espnAbbr: "IONA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fair", name: "Fairfield Stags", shortName: "Fairfield", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2217.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2217", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2217", apiSchedule: "sports/basketball/mens-college-basketball/teams/2217/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2217/roster", teamId: "2217", espnAbbr: "FAIR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-msm", name: "Mount St. Mary's Mountaineers", shortName: "Mount St Marys", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/116.png", accent: "#005596", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/116", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/116", apiSchedule: "sports/basketball/mens-college-basketball/teams/116/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/116/roster", teamId: "116", espnAbbr: "MSM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mrst", name: "Marist Red Foxes", shortName: "Marist", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2368.png", accent: "#e53730", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2368", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2368", apiSchedule: "sports/basketball/mens-college-basketball/teams/2368/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2368/roster", teamId: "2368", espnAbbr: "MRST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-quin", name: "Quinnipiac Bobcats", shortName: "Quinnipiac", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2514.png", accent: "#041B43", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2514", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2514", apiSchedule: "sports/basketball/mens-college-basketball/teams/2514/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2514/roster", teamId: "2514", espnAbbr: "QUIN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sie", name: "Siena Saints", shortName: "Siena", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2561.png", accent: "#037961", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2561", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2561", apiSchedule: "sports/basketball/mens-college-basketball/teams/2561/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2561/roster", teamId: "2561", espnAbbr: "SIE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-spu", name: "Saint Peter's Peacocks", shortName: "Saint Peter's", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2612.png", accent: "#004CC2", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2612", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2612", apiSchedule: "sports/basketball/mens-college-basketball/teams/2612/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2612/roster", teamId: "2612", espnAbbr: "SPU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mrmk", name: "Merrimack Warriors", shortName: "Merrimack", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2771.png", accent: "#2f4f93", league: "NCAAM", leagueTag: "NCAAM", conference: "Metro Atlantic Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2771", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2771", apiSchedule: "sports/basketball/mens-college-basketball/teams/2771/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2771/roster", teamId: "2771", espnAbbr: "MRMK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wmu", name: "Western Michigan Broncos", shortName: "W Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2711.png", accent: "#532e1f", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2711", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2711", apiSchedule: "sports/basketball/mens-college-basketball/teams/2711/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2711/roster", teamId: "2711", espnAbbr: "WMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-emu", name: "Eastern Michigan Eagles", shortName: "E Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2199.png", accent: "#00331b", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2199", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2199", apiSchedule: "sports/basketball/mens-college-basketball/teams/2199/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2199/roster", teamId: "2199", espnAbbr: "EMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-niu", name: "Northern Illinois Huskies", shortName: "N Illinois", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2459.png", accent: "#F1122C", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2459", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2459", apiSchedule: "sports/basketball/mens-college-basketball/teams/2459/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2459/roster", teamId: "2459", espnAbbr: "NIU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cmu", name: "Central Michigan Chippewas", shortName: "C Michigan", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2117.png", accent: "#4c0027", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2117", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2117", apiSchedule: "sports/basketball/mens-college-basketball/teams/2117/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2117/roster", teamId: "2117", espnAbbr: "CMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-buf", name: "Buffalo Bulls", shortName: "Buffalo", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2084.png", accent: "#005bbb", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2084", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2084", apiSchedule: "sports/basketball/mens-college-basketball/teams/2084/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2084/roster", teamId: "2084", espnAbbr: "BUF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mass", name: "Massachusetts Minutemen", shortName: "UMass", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/113.png", accent: "#881c1c", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/113", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/113", apiSchedule: "sports/basketball/mens-college-basketball/teams/113/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/113/roster", teamId: "113", espnAbbr: "MASS", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ball", name: "Ball State Cardinals", shortName: "Ball State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2050.png", accent: "#ba0c2f", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2050", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2050", apiSchedule: "sports/basketball/mens-college-basketball/teams/2050/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2050/roster", teamId: "2050", espnAbbr: "BALL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bgsu", name: "Bowling Green Falcons", shortName: "Bowling Green", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/189.png", accent: "#fd5000", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/189", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/189", apiSchedule: "sports/basketball/mens-college-basketball/teams/189/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/189/roster", teamId: "189", espnAbbr: "BGSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ohio", name: "Ohio Bobcats", shortName: "Ohio", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/195.png", accent: "#154734", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/195", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/195", apiSchedule: "sports/basketball/mens-college-basketball/teams/195/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/195/roster", teamId: "195", espnAbbr: "OHIO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tol", name: "Toledo Rockets", shortName: "Toledo", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2649.png", accent: "#0a2240", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2649", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2649", apiSchedule: "sports/basketball/mens-college-basketball/teams/2649/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2649/roster", teamId: "2649", espnAbbr: "TOL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-kent", name: "Kent State Golden Flashes", shortName: "Kent State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2309.png", accent: "#003976", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2309", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2309", apiSchedule: "sports/basketball/mens-college-basketball/teams/2309/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2309/roster", teamId: "2309", espnAbbr: "KENT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-akr", name: "Akron Zips", shortName: "Akron", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2006.png", accent: "#041e42", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2006", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2006", apiSchedule: "sports/basketball/mens-college-basketball/teams/2006/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2006/roster", teamId: "2006", espnAbbr: "AKR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-m-oh", name: "Miami (OH) RedHawks", shortName: "Miami OH", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/193.png", accent: "#c41230", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-American Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/193", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/193", apiSchedule: "sports/basketball/mens-college-basketball/teams/193/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/193/roster", teamId: "193", espnAbbr: "M-OH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-dsu", name: "Delaware State Hornets", shortName: "Delaware St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2169.png", accent: "#009cdb", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2169", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2169", apiSchedule: "sports/basketball/mens-college-basketball/teams/2169/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2169/roster", teamId: "2169", espnAbbr: "DSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-umes", name: "Maryland Eastern Shore Hawks", shortName: "MD Eastern", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2379.png", accent: "#5c2301", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2379", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2379", apiSchedule: "sports/basketball/mens-college-basketball/teams/2379/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2379/roster", teamId: "2379", espnAbbr: "UMES", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-copp", name: "Coppin State Eagles", shortName: "Coppin St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2154.png", accent: "#2e3192", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2154", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2154", apiSchedule: "sports/basketball/mens-college-basketball/teams/2154/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2154/roster", teamId: "2154", espnAbbr: "COPP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-scst", name: "South Carolina State Bulldogs", shortName: "SC State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2569.png", accent: "#7d1315", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2569", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2569", apiSchedule: "sports/basketball/mens-college-basketball/teams/2569/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2569/roster", teamId: "2569", espnAbbr: "SCST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-norf", name: "Norfolk State Spartans", shortName: "Norfolk St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2450.png", accent: "#0c8968", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2450", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2450", apiSchedule: "sports/basketball/mens-college-basketball/teams/2450/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2450/roster", teamId: "2450", espnAbbr: "NORF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nccu", name: "North Carolina Central Eagles", shortName: "NC Central", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2428.png", accent: "#880023", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2428", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2428", apiSchedule: "sports/basketball/mens-college-basketball/teams/2428/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2428/roster", teamId: "2428", espnAbbr: "NCCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-morg", name: "Morgan State Bears", shortName: "Morgan St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2415.png", accent: "#014786", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2415", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2415", apiSchedule: "sports/basketball/mens-college-basketball/teams/2415/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2415/roster", teamId: "2415", espnAbbr: "MORG", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-how", name: "Howard Bison", shortName: "Howard", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/47.png", accent: "#003a63", league: "NCAAM", leagueTag: "NCAAM", conference: "Mid-Eastern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/47", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/47", apiSchedule: "sports/basketball/mens-college-basketball/teams/47/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/47/roster", teamId: "47", espnAbbr: "HOW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-evan", name: "Evansville Purple Aces", shortName: "Evansville", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/339.png", accent: "#663399", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/339", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/339", apiSchedule: "sports/basketball/mens-college-basketball/teams/339/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/339/roster", teamId: "339", espnAbbr: "EVAN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-inst", name: "Indiana State Sycamores", shortName: "Indiana St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/282.png", accent: "#00669a", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/282", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/282", apiSchedule: "sports/basketball/mens-college-basketball/teams/282/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/282/roster", teamId: "282", espnAbbr: "INST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-drke", name: "Drake Bulldogs", shortName: "Drake", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2181.png", accent: "#005596", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2181", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2181", apiSchedule: "sports/basketball/mens-college-basketball/teams/2181/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2181/roster", teamId: "2181", espnAbbr: "DRKE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-siu", name: "Southern Illinois Salukis", shortName: "S Illinois", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/79.png", accent: "#85283D", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/79", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/79", apiSchedule: "sports/basketball/mens-college-basketball/teams/79/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/79/roster", teamId: "79", espnAbbr: "SIU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uni", name: "Northern Iowa Panthers", shortName: "Northern Iowa", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2460.png", accent: "#473282", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2460", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2460", apiSchedule: "sports/basketball/mens-college-basketball/teams/2460/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2460/roster", teamId: "2460", espnAbbr: "UNI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-val", name: "Valparaiso Beacons", shortName: "Valparaiso", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2674.png", accent: "#794500", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2674", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2674", apiSchedule: "sports/basketball/mens-college-basketball/teams/2674/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2674/roster", teamId: "2674", espnAbbr: "VAL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ilst", name: "Illinois State Redbirds", shortName: "Illinois St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2287.png", accent: "#CE1126", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2287", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2287", apiSchedule: "sports/basketball/mens-college-basketball/teams/2287/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2287/roster", teamId: "2287", espnAbbr: "ILST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mur", name: "Murray State Racers", shortName: "Murray St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/93.png", accent: "#002148", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/93", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/93", apiSchedule: "sports/basketball/mens-college-basketball/teams/93/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/93/roster", teamId: "93", espnAbbr: "MUR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uic", name: "UIC Flames", shortName: "UIC", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/82.png", accent: "#001e62", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/82", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/82", apiSchedule: "sports/basketball/mens-college-basketball/teams/82/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/82/roster", teamId: "82", espnAbbr: "UIC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-brad", name: "Bradley Braves", shortName: "Bradley", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/71.png", accent: "#b70002", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/71", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/71", apiSchedule: "sports/basketball/mens-college-basketball/teams/71/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/71/roster", teamId: "71", espnAbbr: "BRAD", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bel", name: "Belmont Bruins", shortName: "Belmont", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2057.png", accent: "#182142", league: "NCAAM", leagueTag: "NCAAM", conference: "Missouri Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2057", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2057", apiSchedule: "sports/basketball/mens-college-basketball/teams/2057/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2057/roster", teamId: "2057", espnAbbr: "BEL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-af", name: "Air Force Falcons", shortName: "Air Force", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2005.png", accent: "#003594", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2005", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2005", apiSchedule: "sports/basketball/mens-college-basketball/teams/2005/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2005/roster", teamId: "2005", espnAbbr: "AF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sjsu", name: "San José State Spartans", shortName: "San José St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/23.png", accent: "#0038a8", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/23", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/23", apiSchedule: "sports/basketball/mens-college-basketball/teams/23/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/23/roster", teamId: "23", espnAbbr: "SJSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fres", name: "Fresno State Bulldogs", shortName: "Fresno St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/278.png", accent: "#b1102b", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/278", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/278", apiSchedule: "sports/basketball/mens-college-basketball/teams/278/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/278/roster", teamId: "278", espnAbbr: "FRES", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wyo", name: "Wyoming Cowboys", shortName: "Wyoming", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2751.png", accent: "#492f24", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2751", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2751", apiSchedule: "sports/basketball/mens-college-basketball/teams/2751/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2751/roster", teamId: "2751", espnAbbr: "WYO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-csu", name: "Colorado State Rams", shortName: "Colorado St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/36.png", accent: "#004c23", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/36", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/36", apiSchedule: "sports/basketball/mens-college-basketball/teams/36/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/36/roster", teamId: "36", espnAbbr: "CSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unlv", name: "UNLV Rebels", shortName: "UNLV", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2439.png", accent: "#b10202", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2439", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2439", apiSchedule: "sports/basketball/mens-college-basketball/teams/2439/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2439/roster", teamId: "2439", espnAbbr: "UNLV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nev", name: "Nevada Wolf Pack", shortName: "Nevada", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2440.png", accent: "#002d62", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2440", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2440", apiSchedule: "sports/basketball/mens-college-basketball/teams/2440/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2440/roster", teamId: "2440", espnAbbr: "NEV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bois", name: "Boise State Broncos", shortName: "Boise St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/68.png", accent: "#0033a0", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/68", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/68", apiSchedule: "sports/basketball/mens-college-basketball/teams/68/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/68/roster", teamId: "68", espnAbbr: "BOIS", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-unm", name: "New Mexico Lobos", shortName: "New Mexico", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/167.png", accent: "#ba0c2f", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/167", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/167", apiSchedule: "sports/basketball/mens-college-basketball/teams/167/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/167/roster", teamId: "167", espnAbbr: "UNM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gcu", name: "Grand Canyon Lopes", shortName: "Grand Canyon", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2253.png", accent: "#522398", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2253", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2253", apiSchedule: "sports/basketball/mens-college-basketball/teams/2253/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2253/roster", teamId: "2253", espnAbbr: "GCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sdsu", name: "San Diego State Aztecs", shortName: "San Diego St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/21.png", accent: "#a6192e", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/21", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/21", apiSchedule: "sports/basketball/mens-college-basketball/teams/21/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/21/roster", teamId: "21", espnAbbr: "SDSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-usu", name: "Utah State Aggies", shortName: "Utah State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/328.png", accent: "#0f2439", league: "NCAAM", leagueTag: "NCAAM", conference: "Mountain West Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/328", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/328", apiSchedule: "sports/basketball/mens-college-basketball/teams/328/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/328/roster", teamId: "328", espnAbbr: "USU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sfpa", name: "Saint Francis Red Flash", shortName: "Saint Francis", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2598.png", accent: "#a20012", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2598", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2598", apiSchedule: "sports/basketball/mens-college-basketball/teams/2598/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2598/roster", teamId: "2598", espnAbbr: "SFPA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-chst", name: "Chicago State Cougars", shortName: "Chicago St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2130.png", accent: "#006700", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2130", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2130", apiSchedule: "sports/basketball/mens-college-basketball/teams/2130/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2130/roster", teamId: "2130", espnAbbr: "CHST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wag", name: "Wagner Seahawks", shortName: "Wagner", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2681.png", accent: "#00483A", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2681", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2681", apiSchedule: "sports/basketball/mens-college-basketball/teams/2681/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2681/roster", teamId: "2681", espnAbbr: "WAG", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sto", name: "Stonehill Skyhawks", shortName: "Stonehill", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/284.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/284", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/284", apiSchedule: "sports/basketball/mens-college-basketball/teams/284/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/284/roster", teamId: "284", espnAbbr: "STO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fdu", name: "Fairleigh Dickinson Knights", shortName: "FDU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/161.png", accent: "#72293c", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/161", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/161", apiSchedule: "sports/basketball/mens-college-basketball/teams/161/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/161/roster", teamId: "161", espnAbbr: "FDU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nhvn", name: "New Haven Chargers", shortName: "New Haven", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2441.png", accent: "#041e42", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2441", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2441", apiSchedule: "sports/basketball/mens-college-basketball/teams/2441/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2441/roster", teamId: "2441", espnAbbr: "NHVN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-merc", name: "Mercyhurst Lakers", shortName: "Mercyhurst", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2385.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2385", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2385", apiSchedule: "sports/basketball/mens-college-basketball/teams/2385/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2385/roster", teamId: "2385", espnAbbr: "MERC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lem", name: "Le Moyne Dolphins", shortName: "Le Moyne", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2330.png", accent: "#333333", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2330", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2330", apiSchedule: "sports/basketball/mens-college-basketball/teams/2330/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2330/roster", teamId: "2330", espnAbbr: "LEM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ccsu", name: "Central Connecticut Blue Devils", shortName: "C Connecticut", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2115.png", accent: "#1B49A2", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2115", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2115", apiSchedule: "sports/basketball/mens-college-basketball/teams/2115/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2115/roster", teamId: "2115", espnAbbr: "CCSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-liu", name: "Long Island University Sharks", shortName: "Long Island", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/112358.png", accent: "#50c9f7", league: "NCAAM", leagueTag: "NCAAM", conference: "Northeast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/112358", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/112358", apiSchedule: "sports/basketball/mens-college-basketball/teams/112358/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/112358/roster", teamId: "112358", espnAbbr: "LIU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wiu", name: "Western Illinois Leathernecks", shortName: "W Illinois", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2710.png", accent: "#4e1e8a", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2710", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2710", apiSchedule: "sports/basketball/mens-college-basketball/teams/2710/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2710/roster", teamId: "2710", espnAbbr: "WIU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-usi", name: "Southern Indiana Screaming Eagles", shortName: "So Indiana", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/88.png", accent: "#333333", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/88", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/88", apiSchedule: "sports/basketball/mens-college-basketball/teams/88/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/88/roster", teamId: "88", espnAbbr: "USI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tntc", name: "Tennessee Tech Golden Eagles", shortName: "Tennessee Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2635.png", accent: "#5A4099", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2635", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2635", apiSchedule: "sports/basketball/mens-college-basketball/teams/2635/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2635/roster", teamId: "2635", espnAbbr: "TNTC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-eiu", name: "Eastern Illinois Panthers", shortName: "E Illinois", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2197.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2197", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2197", apiSchedule: "sports/basketball/mens-college-basketball/teams/2197/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2197/roster", teamId: "2197", espnAbbr: "EIU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lr", name: "Little Rock Trojans", shortName: "Little Rock", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2031.png", accent: "#AD0000", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2031", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2031", apiSchedule: "sports/basketball/mens-college-basketball/teams/2031/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2031/roster", teamId: "2031", espnAbbr: "LR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lin", name: "Lindenwood Lions", shortName: "Lindenwood", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2815.png", accent: "#333333", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2815", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2815", apiSchedule: "sports/basketball/mens-college-basketball/teams/2815/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2815/roster", teamId: "2815", espnAbbr: "LIN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-siue", name: "SIU Edwardsville Cougars", shortName: "SIUE", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2565.png", accent: "#eb1c23", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2565", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2565", apiSchedule: "sports/basketball/mens-college-basketball/teams/2565/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2565/roster", teamId: "2565", espnAbbr: "SIUE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-utm", name: "UT Martin Skyhawks", shortName: "UT Martin", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2630.png", accent: "#FF6700", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2630", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2630", apiSchedule: "sports/basketball/mens-college-basketball/teams/2630/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2630/roster", teamId: "2630", espnAbbr: "UTM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-semo", name: "Southeast Missouri State Redhawks", shortName: "SE Missouri", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2546.png", accent: "#c8102e", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2546", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2546", apiSchedule: "sports/basketball/mens-college-basketball/teams/2546/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2546/roster", teamId: "2546", espnAbbr: "SEMO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tnst", name: "Tennessee State Tigers", shortName: "Tennessee St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2634.png", accent: "#171796", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2634", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2634", apiSchedule: "sports/basketball/mens-college-basketball/teams/2634/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2634/roster", teamId: "2634", espnAbbr: "TNST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-more", name: "Morehead State Eagles", shortName: "Morehead St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2413.png", accent: "#094FA3", league: "NCAAM", leagueTag: "NCAAM", conference: "Ohio Valley Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2413", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2413", apiSchedule: "sports/basketball/mens-college-basketball/teams/2413/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2413/roster", teamId: "2413", espnAbbr: "MORE", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-army", name: "Army Black Knights", shortName: "Army", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/349.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/349", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/349", apiSchedule: "sports/basketball/mens-college-basketball/teams/349/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/349/roster", teamId: "349", espnAbbr: "ARMY", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-hc", name: "Holy Cross Crusaders", shortName: "Holy Cross", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/107.png", accent: "#582c83", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/107", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/107", apiSchedule: "sports/basketball/mens-college-basketball/teams/107/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/107/roster", teamId: "107", espnAbbr: "HC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-buck", name: "Bucknell Bison", shortName: "Bucknell", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2083.png", accent: "#000060", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2083", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2083", apiSchedule: "sports/basketball/mens-college-basketball/teams/2083/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2083/roster", teamId: "2083", espnAbbr: "BUCK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-l-md", name: "Loyola Maryland Greyhounds", shortName: "Loyola MD", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2352.png", accent: "#76a7a0", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2352", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2352", apiSchedule: "sports/basketball/mens-college-basketball/teams/2352/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2352/roster", teamId: "2352", espnAbbr: "L-MD", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-laf", name: "Lafayette Leopards", shortName: "Lafayette", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/322.png", accent: "#790000", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/322", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/322", apiSchedule: "sports/basketball/mens-college-basketball/teams/322/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/322/roster", teamId: "322", espnAbbr: "LAF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-amer", name: "American University Eagles", shortName: "American", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/44.png", accent: "#c41130", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/44", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/44", apiSchedule: "sports/basketball/mens-college-basketball/teams/44/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/44/roster", teamId: "44", espnAbbr: "AMER", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bu", name: "Boston University Terriers", shortName: "Boston U", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/104.png", accent: "#cc0000", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/104", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/104", apiSchedule: "sports/basketball/mens-college-basketball/teams/104/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/104/roster", teamId: "104", espnAbbr: "BU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-colg", name: "Colgate Raiders", shortName: "Colgate", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2142.png", accent: "#821019", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2142", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2142", apiSchedule: "sports/basketball/mens-college-basketball/teams/2142/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2142/roster", teamId: "2142", espnAbbr: "COLG", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-leh", name: "Lehigh Mountain Hawks", shortName: "Lehigh", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2329.png", accent: "#6c2b2a", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2329", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2329", apiSchedule: "sports/basketball/mens-college-basketball/teams/2329/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2329/roster", teamId: "2329", espnAbbr: "LEH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-navy", name: "Navy Midshipmen", shortName: "Navy", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2426.png", accent: "#00225b", league: "NCAAM", leagueTag: "NCAAM", conference: "Patriot League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2426", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2426", apiSchedule: "sports/basketball/mens-college-basketball/teams/2426/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2426/roster", teamId: "2426", espnAbbr: "NAVY", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lsu", name: "LSU Tigers", shortName: "LSU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/99.png", accent: "#461d76", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/99", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/99", apiSchedule: "sports/basketball/mens-college-basketball/teams/99/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/99/roster", teamId: "99", espnAbbr: "LSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-miss", name: "Ole Miss Rebels", shortName: "Ole Miss", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/145.png", accent: "#13294b", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/145", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/145", apiSchedule: "sports/basketball/mens-college-basketball/teams/145/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/145/roster", teamId: "145", espnAbbr: "MISS", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sc", name: "South Carolina Gamecocks", shortName: "South Carolina", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2579.png", accent: "#73000a", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2579", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2579", apiSchedule: "sports/basketball/mens-college-basketball/teams/2579/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2579/roster", teamId: "2579", espnAbbr: "SC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-msst", name: "Mississippi State Bulldogs", shortName: "Mississippi St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/344.png", accent: "#5d1725", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/344", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/344", apiSchedule: "sports/basketball/mens-college-basketball/teams/344/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/344/roster", teamId: "344", espnAbbr: "MSST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ou", name: "Oklahoma Sooners", shortName: "Oklahoma", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/201.png", accent: "#990000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/201", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/201", apiSchedule: "sports/basketball/mens-college-basketball/teams/201/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/201/roster", teamId: "201", espnAbbr: "OU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-aub", name: "Auburn Tigers", shortName: "Auburn", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2.png", accent: "#002b5c", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2", apiSchedule: "sports/basketball/mens-college-basketball/teams/2/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2/roster", teamId: "2", espnAbbr: "AUB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tex", name: "Texas Longhorns", shortName: "Texas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/251.png", accent: "#af5c37", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/251", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/251", apiSchedule: "sports/basketball/mens-college-basketball/teams/251/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/251/roster", teamId: "251", espnAbbr: "TEX", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uga", name: "Georgia Bulldogs", shortName: "Georgia", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/61.png", accent: "#ba0c2f", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/61", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/61", apiSchedule: "sports/basketball/mens-college-basketball/teams/61/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/61/roster", teamId: "61", espnAbbr: "UGA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-miz", name: "Missouri Tigers", shortName: "Missouri", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/142.png", accent: "#f1b82d", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/142", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/142", apiSchedule: "sports/basketball/mens-college-basketball/teams/142/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/142/roster", teamId: "142", espnAbbr: "MIZ", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uk", name: "Kentucky Wildcats", shortName: "Kentucky", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/96.png", accent: "#0033a0", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/96", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/96", apiSchedule: "sports/basketball/mens-college-basketball/teams/96/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/96/roster", teamId: "96", espnAbbr: "UK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-van", name: "Vanderbilt Commodores", shortName: "Vanderbilt", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/238.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/238", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/238", apiSchedule: "sports/basketball/mens-college-basketball/teams/238/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/238/roster", teamId: "238", espnAbbr: "VAN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tenn", name: "Tennessee Volunteers", shortName: "Tennessee", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2633.png", accent: "#ff8200", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2633", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2633", apiSchedule: "sports/basketball/mens-college-basketball/teams/2633/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2633/roster", teamId: "2633", espnAbbr: "TENN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ta&m", name: "Texas A&M Aggies", shortName: "Texas A&M", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/245.png", accent: "#500000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/245", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/245", apiSchedule: "sports/basketball/mens-college-basketball/teams/245/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/245/roster", teamId: "245", espnAbbr: "TA&M", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ark", name: "Arkansas Razorbacks", shortName: "Arkansas", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/8.png", accent: "#a32136", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/8", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/8", apiSchedule: "sports/basketball/mens-college-basketball/teams/8/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/8/roster", teamId: "8", espnAbbr: "ARK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ala", name: "Alabama Crimson Tide", shortName: "Alabama", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/333.png", accent: "#9e1b32", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/333", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/333", apiSchedule: "sports/basketball/mens-college-basketball/teams/333/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/333/roster", teamId: "333", espnAbbr: "ALA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fla", name: "Florida Gators", shortName: "Florida", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/57.png", accent: "#0021a5", league: "NCAAM", leagueTag: "NCAAM", conference: "Southeastern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/57", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/57", apiSchedule: "sports/basketball/mens-college-basketball/teams/57/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/57/roster", teamId: "57", espnAbbr: "FLA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-vmi", name: "VMI Keydets", shortName: "VMI", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2678.png", accent: "#ae122a", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2678", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2678", apiSchedule: "sports/basketball/mens-college-basketball/teams/2678/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2678/roster", teamId: "2678", espnAbbr: "VMI", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-utc", name: "Chattanooga Mocs", shortName: "Chattanooga", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/236.png", accent: "#00386b", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/236", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/236", apiSchedule: "sports/basketball/mens-college-basketball/teams/236/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/236/roster", teamId: "236", espnAbbr: "UTC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cit", name: "The Citadel Bulldogs", shortName: "The Citadel", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2643.png", accent: "#7badd3", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2643", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2643", apiSchedule: "sports/basketball/mens-college-basketball/teams/2643/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2643/roster", teamId: "2643", espnAbbr: "CIT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uncg", name: "UNC Greensboro Spartans", shortName: "UNC Greensboro", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2430.png", accent: "#003559", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2430", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2430", apiSchedule: "sports/basketball/mens-college-basketball/teams/2430/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2430/roster", teamId: "2430", espnAbbr: "UNCG", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-fur", name: "Furman Paladins", shortName: "Furman", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/231.png", accent: "#582c83", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/231", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/231", apiSchedule: "sports/basketball/mens-college-basketball/teams/231/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/231/roster", teamId: "231", espnAbbr: "FUR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wcu", name: "Western Carolina Catamounts", shortName: "W Carolina", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2717.png", accent: "#492F91", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2717", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2717", apiSchedule: "sports/basketball/mens-college-basketball/teams/2717/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2717/roster", teamId: "2717", espnAbbr: "WCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mer", name: "Mercer Bears", shortName: "Mercer", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2382.png", accent: "#ff7f29", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2382", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2382", apiSchedule: "sports/basketball/mens-college-basketball/teams/2382/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2382/roster", teamId: "2382", espnAbbr: "MER", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wof", name: "Wofford Terriers", shortName: "Wofford", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2747.png", accent: "#533B22", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2747", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2747", apiSchedule: "sports/basketball/mens-college-basketball/teams/2747/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2747/roster", teamId: "2747", espnAbbr: "WOF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sam", name: "Samford Bulldogs", shortName: "Samford", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2535.png", accent: "#005485", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2535", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2535", apiSchedule: "sports/basketball/mens-college-basketball/teams/2535/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2535/roster", teamId: "2535", espnAbbr: "SAM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-etsu", name: "East Tennessee State Buccaneers", shortName: "ETSU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2193.png", accent: "#002d61", league: "NCAAM", leagueTag: "NCAAM", conference: "Southern Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2193", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2193", apiSchedule: "sports/basketball/mens-college-basketball/teams/2193/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2193/roster", teamId: "2193", espnAbbr: "ETSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-etam", name: "East Texas A&M Lions", shortName: "E Texas A&M", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2837.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2837", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2837", apiSchedule: "sports/basketball/mens-college-basketball/teams/2837/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2837/roster", teamId: "2837", espnAbbr: "ETAM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sela", name: "SE Louisiana Lions", shortName: "SE Louisiana", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2545.png", accent: "#215732", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2545", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2545", apiSchedule: "sports/basketball/mens-college-basketball/teams/2545/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2545/roster", teamId: "2545", espnAbbr: "SELA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uiw", name: "Incarnate Word Cardinals", shortName: "Incarnate Word", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2916.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2916", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2916", apiSchedule: "sports/basketball/mens-college-basketball/teams/2916/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2916/roster", teamId: "2916", espnAbbr: "UIW", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lam", name: "Lamar Cardinals", shortName: "Lamar", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2320.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2320", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2320", apiSchedule: "sports/basketball/mens-college-basketball/teams/2320/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2320/roster", teamId: "2320", espnAbbr: "LAM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-hcu", name: "Houston Christian Huskies", shortName: "Hou Christian", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2277.png", accent: "#00539c", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2277", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2277", apiSchedule: "sports/basketball/mens-college-basketball/teams/2277/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2277/roster", teamId: "2277", espnAbbr: "HCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nwst", name: "Northwestern State Demons", shortName: "N'Western St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2466.png", accent: "#492F91", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2466", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2466", apiSchedule: "sports/basketball/mens-college-basketball/teams/2466/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2466/roster", teamId: "2466", espnAbbr: "NWST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uno", name: "New Orleans Privateers", shortName: "New Orleans", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2443.png", accent: "#005da6", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2443", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2443", apiSchedule: "sports/basketball/mens-college-basketball/teams/2443/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2443/roster", teamId: "2443", espnAbbr: "UNO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-nich", name: "Nicholls Colonels", shortName: "Nicholls", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2447.png", accent: "#C41230", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2447", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2447", apiSchedule: "sports/basketball/mens-college-basketball/teams/2447/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2447/roster", teamId: "2447", espnAbbr: "NICH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-amcc", name: "Texas A&M-Corpus Christi Islanders", shortName: "Texas A&M-CC", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/357.png", accent: "#0067c5", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/357", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/357", apiSchedule: "sports/basketball/mens-college-basketball/teams/357/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/357/roster", teamId: "357", espnAbbr: "AMCC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-rgv", name: "UT Rio Grande Valley Vaqueros", shortName: "UT Rio Grande", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/292.png", accent: "#dc6000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/292", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/292", apiSchedule: "sports/basketball/mens-college-basketball/teams/292/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/292/roster", teamId: "292", espnAbbr: "RGV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mcn", name: "McNeese Cowboys", shortName: "McNeese", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2377.png", accent: "#00529C", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2377", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2377", apiSchedule: "sports/basketball/mens-college-basketball/teams/2377/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2377/roster", teamId: "2377", espnAbbr: "MCN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sfa", name: "Stephen F. Austin Lumberjacks", shortName: "SF Austin", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2617.png", accent: "#393996", league: "NCAAM", leagueTag: "NCAAM", conference: "Southland Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2617", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2617", apiSchedule: "sports/basketball/mens-college-basketball/teams/2617/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2617/roster", teamId: "2617", espnAbbr: "SFA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mvsu", name: "Mississippi Valley State Delta Devils", shortName: "Miss Valley St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2400.png", accent: "#005328", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2400", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2400", apiSchedule: "sports/basketball/mens-college-basketball/teams/2400/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2400/roster", teamId: "2400", espnAbbr: "MVSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gram", name: "Grambling Tigers", shortName: "Grambling", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2755.png", accent: "#ee8601", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2755", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2755", apiSchedule: "sports/basketball/mens-college-basketball/teams/2755/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2755/roster", teamId: "2755", espnAbbr: "GRAM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-alst", name: "Alabama State Hornets", shortName: "Alabama St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2011.png", accent: "#e9a900", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2011", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2011", apiSchedule: "sports/basketball/mens-college-basketball/teams/2011/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2011/roster", teamId: "2011", espnAbbr: "ALST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-alcn", name: "Alcorn State Braves", shortName: "Alcorn St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2016.png", accent: "#4b0058", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2016", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2016", apiSchedule: "sports/basketball/mens-college-basketball/teams/2016/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2016/roster", teamId: "2016", espnAbbr: "ALCN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-pv", name: "Prairie View A&M Panthers", shortName: "Prairie View", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2504.png", accent: "#4d0960", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2504", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2504", apiSchedule: "sports/basketball/mens-college-basketball/teams/2504/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2504/roster", teamId: "2504", espnAbbr: "PV", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-aamu", name: "Alabama A&M Bulldogs", shortName: "Alabama A&M", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2010.png", accent: "#790000", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2010", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2010", apiSchedule: "sports/basketball/mens-college-basketball/teams/2010/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2010/roster", teamId: "2010", espnAbbr: "AAMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uapb", name: "Arkansas-Pine Bluff Golden Lions", shortName: "AR-Pine Bluff", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2029.png", accent: "#e0aa0f", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2029", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2029", apiSchedule: "sports/basketball/mens-college-basketball/teams/2029/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2029/roster", teamId: "2029", espnAbbr: "UAPB", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-txso", name: "Texas Southern Tigers", shortName: "Texas Southern", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2640.png", accent: "#860038", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2640", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2640", apiSchedule: "sports/basketball/mens-college-basketball/teams/2640/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2640/roster", teamId: "2640", espnAbbr: "TXSO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-jkst", name: "Jackson State Tigers", shortName: "Jackson St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2296.png", accent: "#123297", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2296", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2296", apiSchedule: "sports/basketball/mens-college-basketball/teams/2296/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2296/roster", teamId: "2296", espnAbbr: "JKST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sou", name: "Southern Jaguars", shortName: "Southern", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2582.png", accent: "#004B97", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2582", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2582", apiSchedule: "sports/basketball/mens-college-basketball/teams/2582/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2582/roster", teamId: "2582", espnAbbr: "SOU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-famu", name: "Florida A&M Rattlers", shortName: "Florida A&M", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/50.png", accent: "#F89728", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/50", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/50", apiSchedule: "sports/basketball/mens-college-basketball/teams/50/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/50/roster", teamId: "50", espnAbbr: "FAMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-bcu", name: "Bethune-Cookman Wildcats", shortName: "Bethune", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2065.png", accent: "#7b1831", league: "NCAAM", leagueTag: "NCAAM", conference: "Southwestern Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2065", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2065", apiSchedule: "sports/basketball/mens-college-basketball/teams/2065/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2065/roster", teamId: "2065", espnAbbr: "BCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-kc", name: "Kansas City Roos", shortName: "Kansas City", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/140.png", accent: "#004b87", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/140", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/140", apiSchedule: "sports/basketball/mens-college-basketball/teams/140/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/140/roster", teamId: "140", espnAbbr: "KC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-oru", name: "Oral Roberts Golden Eagles", shortName: "Oral Roberts", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/198.png", accent: "#002462", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/198", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/198", apiSchedule: "sports/basketball/mens-college-basketball/teams/198/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/198/roster", teamId: "198", espnAbbr: "ORU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sdst", name: "South Dakota State Jackrabbits", shortName: "S Dakota St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2571.png", accent: "#0033a0", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2571", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2571", apiSchedule: "sports/basketball/mens-college-basketball/teams/2571/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2571/roster", teamId: "2571", espnAbbr: "SDST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sdak", name: "South Dakota Coyotes", shortName: "South Dakota", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/233.png", accent: "#CD1241", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/233", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/233", apiSchedule: "sports/basketball/mens-college-basketball/teams/233/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/233/roster", teamId: "233", espnAbbr: "SDAK", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-oma", name: "Omaha Mavericks", shortName: "Omaha", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2437.png", accent: "#e3193e", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2437", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2437", apiSchedule: "sports/basketball/mens-college-basketball/teams/2437/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2437/roster", teamId: "2437", espnAbbr: "OMA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-den", name: "Denver Pioneers", shortName: "Denver", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2172.png", accent: "#98002e", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2172", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2172", apiSchedule: "sports/basketball/mens-college-basketball/teams/2172/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2172/roster", teamId: "2172", espnAbbr: "DEN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-und", name: "North Dakota Fighting Hawks", shortName: "North Dakota", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/155.png", accent: "#00A26B", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/155", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/155", apiSchedule: "sports/basketball/mens-college-basketball/teams/155/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/155/roster", teamId: "155", espnAbbr: "UND", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-stmn", name: "St. Thomas-Minnesota Tommies", shortName: "St Thomas (MN)", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2900.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2900", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2900", apiSchedule: "sports/basketball/mens-college-basketball/teams/2900/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2900/roster", teamId: "2900", espnAbbr: "STMN", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ndsu", name: "North Dakota State Bison", shortName: "N Dakota St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2449.png", accent: "#01402A", league: "NCAAM", leagueTag: "NCAAM", conference: "Summit League", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2449", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2449", apiSchedule: "sports/basketball/mens-college-basketball/teams/2449/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2449/roster", teamId: "2449", espnAbbr: "NDSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ulm", name: "UL Monroe Warhawks", shortName: "UL Monroe", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2433.png", accent: "#231F20", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2433", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2433", apiSchedule: "sports/basketball/mens-college-basketball/teams/2433/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2433/roster", teamId: "2433", espnAbbr: "ULM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-odu", name: "Old Dominion Monarchs", shortName: "Old Dominion", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/295.png", accent: "#003768", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/295", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/295", apiSchedule: "sports/basketball/mens-college-basketball/teams/295/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/295/roster", teamId: "295", espnAbbr: "ODU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ul", name: "Louisiana Ragin' Cajuns", shortName: "Louisiana", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/309.png", accent: "#ce181e", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/309", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/309", apiSchedule: "sports/basketball/mens-college-basketball/teams/309/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/309/roster", teamId: "309", espnAbbr: "UL", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gast", name: "Georgia State Panthers", shortName: "Georgia St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2247.png", accent: "#1e539a", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2247", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2247", apiSchedule: "sports/basketball/mens-college-basketball/teams/2247/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2247/roster", teamId: "2247", espnAbbr: "GAST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gaso", name: "Georgia Southern Eagles", shortName: "GA Southern", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/290.png", accent: "#041e42", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/290", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/290", apiSchedule: "sports/basketball/mens-college-basketball/teams/290/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/290/roster", teamId: "290", espnAbbr: "GASO", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-jmu", name: "James Madison Dukes", shortName: "James Madison", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/256.png", accent: "#450084", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/256", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/256", apiSchedule: "sports/basketball/mens-college-basketball/teams/256/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/256/roster", teamId: "256", espnAbbr: "JMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-usm", name: "Southern Miss Golden Eagles", shortName: "Southern Miss", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2572.png", accent: "#FFAA3C", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2572", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2572", apiSchedule: "sports/basketball/mens-college-basketball/teams/2572/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2572/roster", teamId: "2572", espnAbbr: "USM", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-usa", name: "South Alabama Jaguars", shortName: "South Alabama", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/6.png", accent: "#00205b", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/6", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/6", apiSchedule: "sports/basketball/mens-college-basketball/teams/6/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/6/roster", teamId: "6", espnAbbr: "USA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-arst", name: "Arkansas State Red Wolves", shortName: "Arkansas St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2032.png", accent: "#cc092f", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2032", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2032", apiSchedule: "sports/basketball/mens-college-basketball/teams/2032/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2032/roster", teamId: "2032", espnAbbr: "ARST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-txst", name: "Texas State Bobcats", shortName: "Texas St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/326.png", accent: "#501214", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/326", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/326", apiSchedule: "sports/basketball/mens-college-basketball/teams/326/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/326/roster", teamId: "326", espnAbbr: "TXST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-mrsh", name: "Marshall Thundering Herd", shortName: "Marshall", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/276.png", accent: "#00b140", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/276", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/276", apiSchedule: "sports/basketball/mens-college-basketball/teams/276/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/276/roster", teamId: "276", espnAbbr: "MRSH", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-ccu", name: "Coastal Carolina Chanticleers", shortName: "Coastal", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/324.png", accent: "#006f71", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/324", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/324", apiSchedule: "sports/basketball/mens-college-basketball/teams/324/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/324/roster", teamId: "324", espnAbbr: "CCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-app", name: "App State Mountaineers", shortName: "App State", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2026.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2026", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2026", apiSchedule: "sports/basketball/mens-college-basketball/teams/2026/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2026/roster", teamId: "2026", espnAbbr: "APP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-troy", name: "Troy Trojans", shortName: "Troy", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2653.png", accent: "#AE0210", league: "NCAAM", leagueTag: "NCAAM", conference: "Sun Belt Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2653", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2653", apiSchedule: "sports/basketball/mens-college-basketball/teams/2653/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2653/roster", teamId: "2653", espnAbbr: "TROY", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-pepp", name: "Pepperdine Waves", shortName: "Pepperdine", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2492.png", accent: "#003A72", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2492", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2492", apiSchedule: "sports/basketball/mens-college-basketball/teams/2492/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2492/roster", teamId: "2492", espnAbbr: "PEPP", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-usd", name: "San Diego Toreros", shortName: "San Diego", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/301.png", accent: "#2f99d4", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/301", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/301", apiSchedule: "sports/basketball/mens-college-basketball/teams/301/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/301/roster", teamId: "301", espnAbbr: "USD", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-lmu", name: "Loyola Marymount Lions", shortName: "LMU", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2351.png", accent: "#880029", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2351", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2351", apiSchedule: "sports/basketball/mens-college-basketball/teams/2351/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2351/roster", teamId: "2351", espnAbbr: "LMU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-port", name: "Portland Pilots", shortName: "Portland", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2501.png", accent: "#33007", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2501", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2501", apiSchedule: "sports/basketball/mens-college-basketball/teams/2501/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2501/roster", teamId: "2501", espnAbbr: "PORT", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-wsu", name: "Washington State Cougars", shortName: "Washington St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/265.png", accent: "#a60f2d", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/265", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/265", apiSchedule: "sports/basketball/mens-college-basketball/teams/265/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/265/roster", teamId: "265", espnAbbr: "WSU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sea", name: "Seattle U Redhawks", shortName: "Seattle U", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2547.png", accent: "#BF2E1A", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2547", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2547", apiSchedule: "sports/basketball/mens-college-basketball/teams/2547/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2547/roster", teamId: "2547", espnAbbr: "SEA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-pac", name: "Pacific Tigers", shortName: "Pacific", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/279.png", accent: "#F47820", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/279", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/279", apiSchedule: "sports/basketball/mens-college-basketball/teams/279/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/279/roster", teamId: "279", espnAbbr: "PAC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-sf", name: "San Francisco Dons", shortName: "San Francisco", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2539.png", accent: "#005a36", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2539", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2539", apiSchedule: "sports/basketball/mens-college-basketball/teams/2539/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2539/roster", teamId: "2539", espnAbbr: "SF", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-orst", name: "Oregon State Beavers", shortName: "Oregon St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/204.png", accent: "#dc4405", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/204", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/204", apiSchedule: "sports/basketball/mens-college-basketball/teams/204/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/204/roster", teamId: "204", espnAbbr: "ORST", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-scu", name: "Santa Clara Broncos", shortName: "Santa Clara", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2541.png", accent: "#690b0b", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2541", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2541", apiSchedule: "sports/basketball/mens-college-basketball/teams/2541/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2541/roster", teamId: "2541", espnAbbr: "SCU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-gonz", name: "Gonzaga Bulldogs", shortName: "Gonzaga", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2250.png", accent: "#041e42", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2250", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2250", apiSchedule: "sports/basketball/mens-college-basketball/teams/2250/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2250/roster", teamId: "2250", espnAbbr: "GONZ", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-smc", name: "Saint Mary's Gaels", shortName: "Saint Mary's", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2608.png", accent: "#d80024", league: "NCAAM", leagueTag: "NCAAM", conference: "West Coast Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2608", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2608", apiSchedule: "sports/basketball/mens-college-basketball/teams/2608/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2608/roster", teamId: "2608", espnAbbr: "SMC", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-tar", name: "Tarleton State Texans", shortName: "Tarleton St", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2627.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Western Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2627", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2627", apiSchedule: "sports/basketball/mens-college-basketball/teams/2627/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2627/roster", teamId: "2627", espnAbbr: "TAR", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-acu", name: "Abilene Christian Wildcats", shortName: "Abilene Chrstn", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2000.png", accent: "#592d82", league: "NCAAM", leagueTag: "NCAAM", conference: "Western Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2000", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2000", apiSchedule: "sports/basketball/mens-college-basketball/teams/2000/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2000/roster", teamId: "2000", espnAbbr: "ACU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-suu", name: "Southern Utah Thunderbirds", shortName: "Southern Utah", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/253.png", accent: "#c72026", league: "NCAAM", leagueTag: "NCAAM", conference: "Western Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/253", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/253", apiSchedule: "sports/basketball/mens-college-basketball/teams/253/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/253/roster", teamId: "253", espnAbbr: "SUU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uta", name: "UT Arlington Mavericks", shortName: "UT Arlington", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/250.png", accent: "#004b7c", league: "NCAAM", leagueTag: "NCAAM", conference: "Western Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/250", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/250", apiSchedule: "sports/basketball/mens-college-basketball/teams/250/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/250/roster", teamId: "250", espnAbbr: "UTA", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-utu", name: "Utah Tech Trailblazers", shortName: "Utah Tech", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/3101.png", accent: "#000000", league: "NCAAM", leagueTag: "NCAAM", conference: "Western Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/3101", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/3101", apiSchedule: "sports/basketball/mens-college-basketball/teams/3101/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/3101/roster", teamId: "3101", espnAbbr: "UTU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-cbu", name: "California Baptist Lancers", shortName: "CA Baptist", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/2856.png", accent: "#000080", league: "NCAAM", leagueTag: "NCAAM", conference: "Western Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/2856", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/2856", apiSchedule: "sports/basketball/mens-college-basketball/teams/2856/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/2856/roster", teamId: "2856", espnAbbr: "CBU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
  { id: "ncaam-uvu", name: "Utah Valley Wolverines", shortName: "Utah Valley", logo: "https://a.espncdn.com/i/teamlogos/ncaa/500/3084.png", accent: "#004812", league: "NCAAM", leagueTag: "NCAAM", conference: "Western Athletic Conference", espnUrl: "https://www.espn.com/mens-college-basketball/team/_/id/3084", ticketUrl: "", venue: "", apiTeam: "sports/basketball/mens-college-basketball/teams/3084", apiSchedule: "sports/basketball/mens-college-basketball/teams/3084/schedule", apiStandings: "sports/basketball/mens-college-basketball/standings", apiRoster: "sports/basketball/mens-college-basketball/teams/3084/roster", teamId: "3084", espnAbbr: "UVU", sport: "basketball", isHockey: false, showPlayoffOdds: false, hasSalary: false, salaryCap: "" },
];

// --- API Helper---
// In development, Vite proxies /api to ESPN directly.
// In production on Vercel, /api/espn serverless function handles the proxy.

async function fetchESPN(apiPath, useV2 = false, extraParams = {}) {
  // Vercel serverless route
  const extra = Object.entries(extraParams).map(([k, v]) => `&${k}=${v}`).join("");
  const url = `/api/espn?path=${encodeURIComponent(apiPath)}${useV2 ? '&v2' : ''}${extra}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// --- ESPN Data Parser Hook---
function useTeamData(team) {
  const [schedule, setSchedule] = useState(null);
  const [standings, setStandings] = useState(null);
  const [record, setRecord] = useState("Loading...");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const hasLiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        // Detect football offseason (Jan-Aug) — show previous season data
        const isFootball = team.sport === "football";
        const currentMonth = new Date().getMonth(); // 0-11
        const isFootballOffseason = isFootball && (currentMonth < 7); // Jan(0) through Jul(7)
        const seasonParam = isFootballOffseason ? { season: 2025 } : {};
        const teamParam = isFootballOffseason ? { season: 2025 } : {};

        // Derive scoreboard path from apiSchedule (e.g. "sports/basketball/nba/teams/26/schedule" -> "sports/basketball/nba/scoreboard")
        const scoreboardPath = team.apiSchedule.replace(/\/teams\/.*$/, "/scoreboard");
        // Also fetch postseason schedule for NCAA tournament / bowl games
        const needsPostseason = team.league === "NCAA";
        const postseasonParams = isFootballOffseason ? { season: 2025, seasontype: 3 } : { seasontype: 3 };
        // For football offseason, also fetch team statistics to get the record
        const statsPath = team.apiTeam.replace("/teams/", "/teams/") + "/statistics";
        const [teamData, schedData, standData, scoreboardData, postData, fbStatsData] = await Promise.allSettled([
          fetchESPN(team.apiTeam, false, teamParam),
          fetchESPN(team.apiSchedule, false, seasonParam),
          fetchESPN(team.apiStandings, true),
          isFootballOffseason ? Promise.resolve(null) : fetchESPN(scoreboardPath),
          needsPostseason ? fetchESPN(team.apiSchedule, false, postseasonParams) : Promise.resolve(null),
          isFootballOffseason ? fetchESPN(statsPath, false, { season: 2025 }) : Promise.resolve(null),
        ]);

        if (cancelled) return;

        // Build a map of live scores from the scoreboard endpoint
        const liveScoreMap = {};
        if (scoreboardData.status === "fulfilled") {
          const sbEvents = scoreboardData.value?.events || [];
          for (const ev of sbEvents) {
            const comp = ev.competitions?.[0];
            const statusName = comp?.status?.type?.name || "";
            const sbState = comp?.status?.type?.state || "";
            if (statusName.includes("IN_PROGRESS") || statusName.includes("END_PERIOD") || statusName.includes("HALFTIME") || sbState === "in") {
              const teamComp = comp?.competitors?.find(
                (c) => String(c.team?.id) === String(team.teamId) || c.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase() || c.team?.abbreviation === team.espnAbbr
              );
              if (teamComp) {
                const opp = comp.competitors.find((c) => c !== teamComp);
                liveScoreMap.us = parseInt(teamComp.score || "0");
                liveScoreMap.them = parseInt(opp?.score || "0");
                liveScoreMap.detail = comp.status?.type?.shortDetail || "";
                liveScoreMap.oppName = opp?.team?.displayName || "";
                liveScoreMap.oppAbbr = opp?.team?.abbreviation || "";
              }
            }
          }
        }

        // -- Parse record--
        if (teamData.status === "fulfilled") {
          const t = teamData.value?.team;
          if (t) {
            const rec = t.record?.items?.[0]?.summary;
            if (team.isHockey) {
              const stats = t.record?.items?.[0]?.stats || [];
              const w = stats.find((s) => s.name === "wins")?.value;
              const l = stats.find((s) => s.name === "losses")?.value;
              const otl = stats.find((s) => s.name === "otLosses")?.value;
              const pts = stats.find((s) => s.name === "points")?.value;
              setRecord(w != null ? `${w}-${l}-${otl} | ${pts} PTS` : rec || "--");
            } else {
              setRecord(rec || "--");
            }
          }
        }
        // Football offseason: get record from statistics endpoint if team endpoint didn't have it
        if (isFootballOffseason && fbStatsData?.status === "fulfilled" && fbStatsData.value) {
          const fbRec = fbStatsData.value?.team?.recordSummary;
          if (fbRec) setRecord(fbRec);
        }

        // -- Parse schedule--
        if (schedData.status === "fulfilled") {
          const raw = schedData.value;
          let allEvents = raw?.events || raw?.requestedSeason?.events || [];
          // Merge postseason events (NCAA tournament) if available
          if (postData?.status === "fulfilled" && postData.value) {
            const postEvents = postData.value?.events || postData.value?.requestedSeason?.events || [];
            if (postEvents.length > 0) {
              const existingIds = new Set(allEvents.map(e => e.id));
              const newEvents = postEvents.filter(e => !existingIds.has(e.id));
              allEvents = [...allEvents, ...newEvents].sort((a, b) => new Date(a.date) - new Date(b.date));
            }
          }
          // Find games around today: last 5 completed + next 5 upcoming
          const now = new Date();
          const completed = [];
          const upcoming = [];
          for (const ev of allEvents) {
            const sn = ev.competitions?.[0]?.status?.type?.name || ev.status?.type?.name || "";
            const done = sn.includes("FINAL") || sn === "post" || sn === "STATUS_FINAL";
            if (done) completed.push(ev);
            else upcoming.push(ev);
          }
          const events = [...completed, ...upcoming];
          const parsed = events.map((ev) => {
            const comp = ev.competitions?.[0];
            const us = comp?.competitors?.find(
              (c) => String(c.id) === String(team.teamId) || c.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase()
            );
            const them = comp?.competitors?.find((c) => c !== us);
            const isHome = us?.homeAway === "home";
            const bcast =
              comp?.broadcasts?.[0]?.names?.[0] ||
              comp?.broadcasts?.[0]?.media?.shortName ||
              comp?.geoBroadcasts?.[0]?.media?.shortName ||
              "--";
            const statusName = comp?.status?.type?.name || ev.status?.type?.name || "";
            const isFinal = statusName.includes("FINAL") || statusName === "post" || statusName === "STATUS_FINAL";
            // Check both schedule status AND scoreboard — schedule can lag behind
            const thisOppAbbr = them?.team?.abbreviation || "";
            const scoreboardMatchesThisGame = !isFinal && liveScoreMap.detail && liveScoreMap.oppAbbr && thisOppAbbr === liveScoreMap.oppAbbr;
            const schedState = comp?.status?.type?.state || ev.status?.type?.state || "";
            const isLive = statusName.includes("IN_PROGRESS") || statusName.includes("END_PERIOD") || statusName.includes("HALFTIME") || schedState === "in" || (us && scoreboardMatchesThisGame);
            const statusDetail = comp?.status?.type?.shortDetail || comp?.status?.shortDetail || ev.status?.type?.shortDetail || "";

            let result = "";
            let liveScore = null;
            if ((isFinal || isLive) && us && them) {
              const usS = parseInt(us.score?.displayValue || us.score || "0");
              const thS = parseInt(them.score?.displayValue || them.score || "0");
              if (isFinal && !isLive) {
                result = usS > thS ? `W ${usS}-${thS}` : usS < thS ? `L ${usS}-${thS}` : `T ${usS}-${thS}`;
              }
              if (isLive) {
                // Prefer scoreboard data (has real-time scores) over schedule data
                if (liveScoreMap.detail) {
                  liveScore = { us: liveScoreMap.us, them: liveScoreMap.them, detail: liveScoreMap.detail };
                } else {
                  liveScore = { us: usS, them: thS, detail: statusDetail };
                }
              }
            }

            return {
              date: ev.date || comp?.date,
              opponent: them?.team?.displayName || them?.team?.shortDisplayName || "TBD",
              opponentAbbr: them?.team?.abbreviation || "",
              opponentLogo: them?.team?.logos?.[0]?.href || them?.team?.logo || null,
              home: isHome,
              result,
              status: isLive ? "live" : isFinal ? "post" : "pre",
              broadcast: bcast,
              liveScore,
            };
          });
          hasLiveRef.current = parsed.some((g) => g.status === "live");
          setSchedule(parsed);
        }

        // -- Parse standings--
        if (standData.status === "fulfilled") {
          const raw = standData.value;
          const groups = raw?.children || [];
          let found = [];

          for (const group of groups) {
            // Some structures nest deeper
            const subGroups = group.children || [group];
            for (const sub of subGroups) {
              const entries = sub.standings?.entries || [];
              const match = entries.find(
                (e) =>
                  String(e.team?.id) === String(team.teamId) ||
                  e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase() ||
                  e.team?.abbreviation === team.espnAbbr
              );
              if (match) {
                found = entries.map((e) => {
                  const st = (name) => e.stats?.find((s) => s.name === name);
                  // Derive losses from "overall" (e.g. "11-2") when losses stat is missing (college football)
                  const overallStr = st("overall")?.displayValue ?? "";
                  const overallParts = overallStr.split("-");
                  const derivedLosses = overallParts.length >= 2 ? parseInt(overallParts[1]) : 0;
                  return {
                    team: e.team?.shortDisplayName || e.team?.displayName || "--",
                    logo: e.team?.logos?.[0]?.href,
                    wins: st("wins")?.value ?? st("wins")?.displayValue ?? 0,
                    losses: st("losses")?.value ?? st("losses")?.displayValue ?? derivedLosses,
                    otl: st("otLosses")?.value ?? st("OTLosses")?.displayValue ?? 0,
                    pts: st("points")?.value ?? st("points")?.displayValue ?? 0,
                    pct: st("winPercent")?.displayValue ?? st("winPct")?.displayValue ?? "--",
                    gb: st("gamesBehind")?.displayValue ?? "--",
                    overall: overallStr,
                    seed: st("playoffSeed")?.value ?? 999,
                    isTarget:
                      String(e.team?.id) === String(team.teamId) ||
                      e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase() ||
                      e.team?.abbreviation === team.espnAbbr,
                  };
                });
                // Sort by playoffSeed ascending (ESPN sometimes returns worst-to-best)
                found.sort((a, b) => Number(a.seed) - Number(b.seed));
                break;
              }
            }
            if (found.length > 0) break;
          }
          setStandings(found.slice(0, 16));
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    // Dynamic refresh: 30s when live game detected, 5min otherwise
    let timerId = null;
    function tick() {
      const delay = hasLiveRef.current ? 30 * 1000 : 5 * 60 * 1000;
      timerId = setTimeout(() => {
        load().then(() => { if (!cancelled) tick(); });
      }, delay);
    }
    tick();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [team.id]);

  return { schedule, standings, record, loading, error };
}

// --- Roster Data Hook ---
function useRosterData(team) {
  const [roster, setRoster] = useState(null);
  const [rosterLoading, setRosterLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setRosterLoading(true);
      try {
        const data = await fetchESPN(team.apiRoster);
        if (cancelled) return;

        let players = [];
        // NBA roster is a flat array
        if (Array.isArray(data.athletes) && data.athletes.length > 0 && data.athletes[0]?.fullName) {
          players = data.athletes.map(p => ({
            name: p.displayName || p.fullName,
            jersey: p.jersey || "--",
            position: p.position?.abbreviation || p.position?.displayName || "--",
            age: p.age || "--",
            experience: p.experience?.years ?? "--",
            salary: p.contract?.salary || null,
            yearsRemaining: p.contract?.yearsRemaining ?? null,
            headshot: p.headshot?.href,
            status: p.status?.name || "Active",
          }));
        }
        // NHL/College roster is grouped by position
        else if (data.athletes) {
          for (const group of data.athletes) {
            const items = group.items || [];
            for (const p of items) {
              players.push({
                name: p.displayName || p.fullName,
                jersey: p.jersey || "--",
                position: p.position?.abbreviation || p.position?.displayName || "--",
                age: p.age || "--",
                experience: p.experience?.years ?? "--",
                salary: p.contract?.salary || null,
                yearsRemaining: p.contract?.yearsRemaining ?? null,
                headshot: p.headshot?.href,
                status: p.status?.name || "Active",
              });
            }
          }
        }

        // Sort by jersey number
        players.sort((a, b) => {
          const na = parseInt(a.jersey) || 999;
          const nb = parseInt(b.jersey) || 999;
          return na - nb;
        });

        setRoster(players);
      } catch (e) {
        if (!cancelled) setRoster([]);
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [team.id]);

  return { roster, rosterLoading };
}

// --- Utility helpers---
function formatDate(d) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function formatTime(d) {
  return new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function formatDayDate(d) {
  return new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// --- Tabs---
function Tabs({ tabs, accent }) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div style={{ display: "flex", gap: 2, marginBottom: 12, borderBottom: `1px solid ${accent}33`, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            onClick={() => setActive(i)}
            style={{
              background: active === i ? accent + "22" : "transparent",
              color: active === i ? accent : "#aaa",
              border: "none",
              borderBottom: active === i ? `2px solid ${accent}` : "2px solid transparent",
              padding: "8px 10px", fontSize: 11,
              fontWeight: active === i ? 700 : 500,
              cursor: "pointer", transition: "all 0.2s",
              letterSpacing: 0.3, textTransform: "uppercase",
              whiteSpace: "nowrap", flexShrink: 0,
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div style={{ minHeight: 200 }}>{tabs[active]?.content}</div>
    </div>
  );
}

// --- Schedule Tab---
function ScheduleTab({ schedule, accent }) {
  if (!schedule || schedule.length === 0)
    return <div style={{ color: "#777", padding: 12 }}>No schedule data available</div>;
  const live = schedule.filter((g) => g.status === "live");
  const recent = schedule.filter((g) => g.status === "post");
  const upcoming = schedule.filter((g) => g.status === "pre");

  return (
    <div style={{ maxHeight: 320, overflowY: "auto" }}>
      {/* LIVE GAMES */}
      {live.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          {live.map((g, i) => (
            <div key={`live-${i}`} style={{
              background: "linear-gradient(135deg, #CC000018, #ff440018)",
              border: "1px solid #CC000044",
              borderRadius: 10, padding: "12px 14px", marginBottom: 8,
              animation: "livePulse 2s ease-in-out infinite",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    background: "#CC0000", color: "#fff", fontSize: 9, fontWeight: 800,
                    padding: "2px 8px", borderRadius: 4, letterSpacing: 1,
                    animation: "liveBlink 1.5s ease-in-out infinite",
                  }}>LIVE</span>
                  <span style={{ color: "#888", fontSize: 11 }}>{g.home ? "vs" : "@"} {g.opponent}</span>
                </div>
                <span style={{ color: "#888", fontSize: 10 }}>{g.broadcast}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: accent, fontSize: 28, fontWeight: 900, fontFamily: "monospace" }}>
                    {g.liveScore?.us ?? 0}
                  </div>
                </div>
                <div style={{ color: "#555", fontSize: 12, textAlign: "center" }}>
                  <div style={{ fontWeight: 700, color: "#CC0000", fontSize: 10 }}>
                    {g.liveScore?.detail || "In Progress"}
                  </div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ color: "#999", fontSize: 28, fontWeight: 900, fontFamily: "monospace" }}>
                    {g.liveScore?.them ?? 0}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {upcoming.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={subheaderStyle}>Upcoming Games</div>
          {upcoming.map((g, i) => (
            <div key={i} style={rowStyle(i)}>
              <div style={{ flex: 1 }}>
                <div style={{ color: "#999", fontSize: 11 }}>{formatDayDate(g.date)}</div>
                <div>
                  <span style={{ color: "#555", fontSize: 11 }}>{g.home ? "vs" : "@"}</span>{" "}
                  <span style={{ color: "#eee", fontSize: 13, fontWeight: 500 }}>{g.opponent}</span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: accent, fontSize: 12, fontWeight: 600 }}>{formatTime(g.date)}</div>
                <div style={{ color: "#888", fontSize: 11 }}>TV: {g.broadcast}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {recent.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={subheaderStyle}>Recent Results</div>
          {[...recent].reverse().map((g, i) => (
            <div key={i} style={rowStyle(i)}>
              <div style={{ flex: 1 }}>
                <span style={{ color: "#999", fontSize: 11 }}>{formatDate(g.date)}</span>
                <span style={{ color: "#555", fontSize: 11, margin: "0 6px" }}>{g.home ? "vs" : "@"}</span>
                <span style={{ color: "#eee", fontSize: 13, fontWeight: 500 }}>{g.opponent}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "#666", fontSize: 10 }}>{g.broadcast}</span>
                <span style={{
                  color: g.result?.startsWith("W") ? "#4CAF50" : "#f44336",
                  fontWeight: 700, fontSize: 13, fontFamily: "monospace",
                  minWidth: 80, textAlign: "right",
                }}>
                  {g.result}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Standings Tab---
function StandingsTab({ standings, accent, team }) {
  if (!standings || standings.length === 0)
    return <div style={{ color: "#777", padding: 12 }}>Standings not available</div>;

  return (
    <div>
      <div style={subheaderStyle}>{team.conference}</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#666", borderBottom: "1px solid #333" }}>
            <th style={thStyle}>#</th>
            <th style={{ ...thStyle, textAlign: "left" }}>Team</th>
            <th style={thStyle}>W</th>
            <th style={thStyle}>L</th>
            {team.isHockey && <th style={thStyle}>OTL</th>}
            <th style={thStyle}>{team.isHockey ? "PTS" : (team.league === "NBA" || team.league === "MLB") ? "GB" : "Overall"}</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((e, i) => (
            <tr key={i} style={{
              background: e.isTarget ? accent + "18" : i % 2 === 0 ? "#1a1a2e" : "transparent",
              borderLeft: e.isTarget ? `3px solid ${accent}` : "3px solid transparent",
            }}>
              <td style={{ ...tdStyle, color: "#888" }}>{i + 1}</td>
              <td style={{ ...tdStyle, textAlign: "left", color: e.isTarget ? accent : "#ddd", fontWeight: e.isTarget ? 700 : 400 }}>
                {e.logo && <img src={e.logo} alt="" style={{ width: 14, height: 14, borderRadius: 2, marginRight: 6, verticalAlign: "middle" }} />}
                {e.team}
              </td>
              <td style={tdStyle}>{e.wins}</td>
              <td style={tdStyle}>{e.losses}</td>
              {team.isHockey && <td style={tdStyle}>{e.otl}</td>}
              <td style={{ ...tdStyle, fontFamily: "monospace" }}>
                {team.isHockey ? e.pts : (team.league === "NBA" || team.league === "MLB") ? e.gb : e.overall || e.pct}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Roster Tab ---
function RosterTab({ roster, accent, team }) {
  if (!roster || roster.length === 0)
    return <div style={{ color: "#777", padding: 12 }}>Roster not available</div>;

  const totalSalary = roster.reduce((sum, p) => sum + (p.salary || 0), 0);
  const hasSalaryData = roster.some(p => p.salary);

  function formatSalary(val) {
    if (!val) return "--";
    if (val >= 1000000) return "$" + (val / 1000000).toFixed(1) + "M";
    if (val >= 1000) return "$" + (val / 1000).toFixed(0) + "K";
    return "$" + val;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={subheaderStyle}>{roster.length} Players</div>
        {hasSalaryData && team.salaryCap && (
          <div style={{ fontSize: 10, color: "#888" }}>
            Cap: {team.salaryCap} | Payroll: {formatSalary(totalSalary)}
          </div>
        )}
      </div>
      <div style={{ maxHeight: 300, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ color: "#666", borderBottom: "1px solid #333", position: "sticky", top: 0, background: "#12121f" }}>
              <th style={{ ...thStyle, width: 30 }}>#</th>
              <th style={{ ...thStyle, textAlign: "left" }}>Player</th>
              <th style={{ ...thStyle, width: 40 }}>Pos</th>
              <th style={{ ...thStyle, width: 35 }}>Age</th>
              {hasSalaryData && <th style={{ ...thStyle, width: 70 }}>Salary</th>}
              {hasSalaryData && <th style={{ ...thStyle, width: 40 }}>Yrs</th>}
            </tr>
          </thead>
          <tbody>
            {roster.map((p, i) => (
              <tr key={i} style={{
                background: i % 2 === 0 ? "#1a1a2e" : "transparent",
              }}>
                <td style={{ ...tdStyle, color: accent, fontWeight: 600, fontSize: 11 }}>{p.jersey}</td>
                <td style={{ ...tdStyle, textAlign: "left", color: "#eee", fontWeight: 500 }}>
                  {p.name}
                </td>
                <td style={{ ...tdStyle, fontSize: 10 }}>{p.position}</td>
                <td style={tdStyle}>{p.age}</td>
                {hasSalaryData && <td style={{ ...tdStyle, fontFamily: "monospace", fontSize: 10, color: p.salary ? "#8BC34A" : "#555" }}>{formatSalary(p.salary)}</td>}
                {hasSalaryData && <td style={{ ...tdStyle, color: p.yearsRemaining != null ? "#ccc" : "#555" }}>{p.yearsRemaining != null ? p.yearsRemaining : "--"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// --- Football Team Stats Tab ---
function FootballStatsTab({ team, accent }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/espn?path=${team.apiTeam.replace('/teams/', '/teams/')}/statistics&season=2025`);
        const data = await res.json();
        const cats = data?.results?.stats?.categories || [];
        const getStat = (catName, abbr) => {
          const cat = cats.find(c => c.name === catName);
          const s = cat?.stats?.find(st => st.abbreviation === abbr);
          return s ? { value: s.displayValue, perGame: s.perGameDisplayValue, name: s.displayName } : null;
        };
        setStats({
          passing: { yds: getStat("passing", "YDS"), td: getStat("passing", "TD"), cmpPct: getStat("passing", "CMP%"), int: getStat("passing", "INT"), att: getStat("passing", "ATT") },
          rushing: { yds: getStat("rushing", "YDS"), td: getStat("rushing", "TD"), avg: getStat("rushing", "AVG"), car: getStat("rushing", "CAR") },
          receiving: { yds: getStat("receiving", "YDS"), td: getStat("receiving", "TD"), rec: getStat("receiving", "REC") },
          defense: { sacks: getStat("defensive", "SACK"), tfl: getStat("defensive", "TFL"), tackles: getStat("defensive", "TOT") },
          interceptions: { int: getStat("defensiveInterceptions", "INT") },
          scoring: { pts: getStat("scoring", "PTS"), ppg: getStat("scoring", "PPG") },
          turnovers: { to: getStat("general", "TO"), pen: getStat("general", "PEN") },
        });
      } catch (e) {
        console.error("Football stats error:", e);
        setStats(null);
      }
      setLoading(false);
    })();
  }, [team.apiTeam]);

  if (loading) return <div style={{ color: "#888", padding: 20, textAlign: "center" }}>Loading stats...</div>;
  if (!stats) return <div style={{ color: "#888", padding: 20, textAlign: "center" }}>Stats not available</div>;

  const StatCard = ({ label, value, sub }) => (
    <div style={{ background: accent + "10", borderRadius: 8, padding: "10px 12px", textAlign: "center" }}>
      <div style={{ color: "#888", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
      <div style={{ color: "#fff", fontSize: 20, fontWeight: 700 }}>{value || "--"}</div>
      {sub && <div style={{ color: "#888", fontSize: 10, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  const SectionHeader = ({ title }) => (
    <div style={{ color: accent, fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, margin: "14px 0 8px", borderBottom: `1px solid ${accent}33`, paddingBottom: 4 }}>{title}</div>
  );

  return (
    <div style={{ padding: "4px 8px" }}>
      <div style={{ color: "#666", fontSize: 10, textAlign: "right", marginBottom: 8 }}>2025 Season</div>

      <SectionHeader title="Offense" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <StatCard label="Pass YDS" value={stats.passing.yds?.value} sub={`${stats.passing.cmpPct?.value || '--'}% CMP`} />
        <StatCard label="Pass TD" value={stats.passing.td?.value} sub={`${stats.passing.int?.value || '0'} INT`} />
        <StatCard label="Rush YDS" value={stats.rushing.yds?.value} sub={`${stats.rushing.avg?.value || '--'} AVG`} />
        <StatCard label="Rush TD" value={stats.rushing.td?.value} sub={`${stats.rushing.car?.value || '--'} CAR`} />
        <StatCard label="Rec YDS" value={stats.receiving.yds?.value} sub={`${stats.receiving.rec?.value || '--'} REC`} />
        <StatCard label="Rec TD" value={stats.receiving.td?.value} />
      </div>

      <SectionHeader title="Defense" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <StatCard label="Tackles" value={stats.defense.tackles?.value} />
        <StatCard label="Sacks" value={stats.defense.sacks?.value} />
        <StatCard label="TFL" value={stats.defense.tfl?.value} />
        <StatCard label="INT" value={stats.interceptions.int?.value} />
        <StatCard label="Points Allowed" value={stats.scoring.pts?.value ? null : "--"} />
        <StatCard label="Turnovers" value={stats.turnovers.to?.value} sub={`${stats.turnovers.pen?.value || '--'} PEN`} />
      </div>

      <SectionHeader title="Scoring" />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        <StatCard label="Total Points" value={stats.scoring.pts?.value} sub={stats.scoring.ppg?.value ? `${stats.scoring.ppg.value} PPG` : null} />
        <StatCard label="Total TDs" value={stats.passing.td && stats.rushing.td ? String(parseInt(stats.passing.td.value) + parseInt(stats.rushing.td.value) + parseInt(stats.receiving.td?.value || "0")) : "--"} />
      </div>

      <div style={{ textAlign: "center", marginTop: 12 }}>
        <a href={team.espnUrl} target="_blank" rel="noopener noreferrer" style={{ color: accent, fontSize: 11, textDecoration: "underline" }}>
          Full stats on ESPN
        </a>
      </div>
    </div>
  );
}

// --- Stats Tab (Individual Player Stats) ---
function StatsTab({ team, accent }) {
  const [players, setPlayers] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortCol, setSortCol] = useState(null);
  const [sortAsc, setSortAsc] = useState(false);

  // Football uses team-level stats from the statistics endpoint
  if (team.sport === "football") {
    return <FootballStatsTab team={team} accent={accent} />;
  }

  const isHockey = team.isHockey;
  const isBaseball = team.sport === "baseball";
  // Derive league and sport from the team's API path (e.g. "sports/basketball/mens-college-basketball/teams/254/roster")
  const apiParts = team.apiRoster.split("/");
  const sport = apiParts[1]; // "hockey", "basketball", "football", "baseball"
  const league = apiParts[2]; // "nhl", "nba", "mens-college-basketball", "college-football", "mlb"
  // Season year: 2025-26 seasons = 2026 for most sports; MLB 2026 season starts late March
  const now = new Date();
  const mlbSeasonStarted = now.getMonth() >= 3; // April or later
  const season = isBaseball ? (mlbSeasonStarted ? 2026 : 2025) : 2026;

  const columns = isHockey
    ? [
        { key: "gp", label: "GP" },
        { key: "g", label: "G" },
        { key: "a", label: "A" },
        { key: "pts", label: "PTS" },
        { key: "pm", label: "+/-" },
      ]
    : isBaseball
    ? [
        { key: "gp", label: "GP" },
        { key: "avg", label: "AVG" },
        { key: "hr", label: "HR" },
        { key: "rbi", label: "RBI" },
        { key: "ops", label: "OPS" },
      ]
    : [
        { key: "gp", label: "GP" },
        { key: "mpg", label: "MPG" },
        { key: "ppg", label: "PPG" },
        { key: "rpg", label: "RPG" },
        { key: "apg", label: "APG" },
        { key: "spg", label: "SPG" },
        { key: "bpg", label: "BPG" },
        { key: "pm", label: "+/-" },
      ];

  useEffect(() => {
    (async () => {
      try {
        // 1. Fetch roster to get player IDs (NHL = grouped by position, NBA = flat)
        const rosterRes = await fetch(`/api/espn?path=${team.apiRoster}`);
        const rosterData = await rosterRes.json();
        const rawAthletes = rosterData?.athletes || [];
        const rosterPlayers = rawAthletes[0]?.items
          ? rawAthletes.flatMap((g) => g.items || [])
          : rawAthletes;

        // 2. Fetch each player's stats in parallel (batches of 10)
        const results = [];
        for (let i = 0; i < rosterPlayers.length; i += 10) {
          const batch = rosterPlayers.slice(i, i + 10);
          const batchResults = await Promise.all(
            batch.map(async (p) => {
              try {
                const sr = await fetch(
                  `/api/espn?path=sports/${sport}/leagues/${league}/seasons/${season}/types/2/athletes/${p.id}/statistics&core`
                );
                if (!sr.ok) return null;
                const sd = await sr.json();
                const cats = sd?.splits?.categories || [];
                const allStats = cats.flatMap((c) => c.stats);
                const find = (abbr, catName) => {
                  if (catName) {
                    const cat = cats.find((c) => c.name === catName);
                    return cat?.stats?.find((s) => s.abbreviation === abbr);
                  }
                  return allStats.find((s) => s.abbreviation === abbr);
                };
                const gp = parseFloat(find("GP", "general")?.displayValue || find("GP", "batting")?.displayValue || find("GP", "pitching")?.displayValue || find("GP")?.displayValue || "0");
                if (gp === 0) return null;

                if (isHockey) {
                  return {
                    name: p.displayName,
                    pos: p.position?.abbreviation || "",
                    jersey: p.jersey || "",
                    headshot: p.headshot?.href || null,
                    gp,
                    g: parseFloat(find("G", "offensive")?.displayValue || "0"),
                    a: parseFloat(find("A", "offensive")?.displayValue || "0"),
                    pts: parseFloat(find("PTS", "offensive")?.displayValue || "0"),
                    pm: parseFloat(find("+/-", "general")?.displayValue || "0"),
                  };
                } else if (isBaseball) {
                  // Check if this player has batting stats (position players)
                  const hasBatting = cats.some((c) => c.name === "batting");
                  if (!hasBatting) return null; // skip pitchers without batting stats
                  const avg = parseFloat(find("AVG", "batting")?.displayValue || "0");
                  const hr = parseFloat(find("HR", "batting")?.displayValue || "0");
                  const rbi = parseFloat(find("RBI", "batting")?.displayValue || "0");
                  const ops = parseFloat(find("OPS", "batting")?.displayValue || "0");
                  if (avg === 0 && hr === 0 && rbi === 0) return null; // no meaningful batting data
                  return {
                    name: p.displayName,
                    pos: p.position?.abbreviation || "",
                    jersey: p.jersey || "",
                    headshot: p.headshot?.href || null,
                    gp,
                    avg: avg.toFixed(3).replace(/^0/, ''),
                    hr,
                    rbi,
                    ops: ops.toFixed(3).replace(/^0/, ''),
                  };
                } else {
                  const mins = parseFloat(find("MIN")?.displayValue || "0");
                  const pts = parseFloat(find("PTS")?.displayValue || "0");
                  const reb = parseFloat(find("REB")?.displayValue || "0");
                  const ast = parseFloat(find("AST")?.displayValue || "0");
                  const stl = parseFloat(find("STL")?.displayValue || "0");
                  const blk = parseFloat(find("BLK")?.displayValue || "0");
                  const pm = parseFloat(find("+/-")?.displayValue || "0");
                  return {
                    name: p.displayName,
                    pos: p.position?.abbreviation || "",
                    jersey: p.jersey || "",
                    headshot: p.headshot?.href || null,
                    gp,
                    mpg: (mins / gp).toFixed(1),
                    ppg: (pts / gp).toFixed(1),
                    rpg: (reb / gp).toFixed(1),
                    apg: (ast / gp).toFixed(1),
                    spg: (stl / gp).toFixed(1),
                    bpg: (blk / gp).toFixed(1),
                    pm,
                  };
                }
              } catch {
                return null;
              }
            })
          );
          results.push(...batchResults.filter(Boolean));
        }

        // Default sort: PTS desc for hockey, PPG desc for basketball, HR desc for baseball
        const defaultSort = isHockey ? "pts" : isBaseball ? "hr" : "ppg";
        results.sort((a, b) => b[defaultSort] - a[defaultSort]);
        setPlayers(results);
        setSortCol(defaultSort);
      } catch (e) {
        console.error("Stats load error:", e);
        setPlayers([]);
      }
      setLoading(false);
    })();
  }, [team]);

  const handleSort = (key) => {
    if (sortCol === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(key);
      setSortAsc(false);
    }
  };

  if (loading) return <div style={{ color: "#888", padding: 20, textAlign: "center" }}>Loading player stats...</div>;
  if (!players || players.length === 0) return <div style={{ color: "#777", padding: 12 }}>Player stats not available</div>;

  const sorted = [...players].sort((a, b) => {
    if (!sortCol) return 0;
    const av = parseFloat(a[sortCol]) || 0;
    const bv = parseFloat(b[sortCol]) || 0;
    return sortAsc ? av - bv : bv - av;
  });

  return (
    <div style={{ maxHeight: 340, overflowY: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ color: "#666", borderBottom: "1px solid #333", position: "sticky", top: 0, background: "#12121f", zIndex: 1 }}>
            <th style={{ ...thStyle, textAlign: "left", minWidth: 100 }}>Player</th>
            <th style={{ ...thStyle, width: 32 }}>Pos</th>
            {columns.map((c) => (
              <th key={c.key} onClick={() => handleSort(c.key)} style={{
                ...thStyle, width: 42, cursor: "pointer", color: sortCol === c.key ? accent : "#666",
              }}>
                {c.label}{sortCol === c.key ? (sortAsc ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((p, i) => (
            <tr key={p.name} style={{ background: i % 2 === 0 ? "#1a1a2e" : "transparent" }}>
              <td style={{ ...tdStyle, textAlign: "left", display: "flex", alignItems: "center", gap: 6 }}>
                {p.headshot ? (
                  <img src={p.headshot} alt="" style={{ width: 20, height: 20, borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#2a2a3e", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8, color: "#666" }}>{p.jersey}</div>
                )}
                <span style={{ color: "#eee", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              </td>
              <td style={{ ...tdStyle, fontSize: 10, color: "#888" }}>{p.pos}</td>
              {columns.map((c) => (
                <td key={c.key} style={{
                  ...tdStyle,
                  color: c.key === (isHockey ? "pts" : isBaseball ? "hr" : "ppg") ? accent : "#ccc",
                  fontWeight: c.key === (isHockey ? "pts" : isBaseball ? "hr" : "ppg") ? 700 : 400,
                  fontFamily: "monospace", fontSize: 11,
                }}>
                  {p[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Playoff Odds Gauge (Mammoth)---
function PlayoffOddsTab({ team, accent }) {
  const [odds, setOdds] = useState(null);
  const [rank, setRank] = useState(null);
  const [confTeams, setConfTeams] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetchESPN(team.apiStandings, true);
        // Determine which conference our team is in
        const conferences = r?.children || [];
        let myConf = null;
        let myTeamEntry = null;
        for (const conf of conferences) {
          const entries = conf.standings?.entries || [];
          // Also check children (divisions) if entries are nested
          const allEntries = entries.length > 0 ? entries : (conf.children || []).flatMap(d => d.standings?.entries || []);
          const found = allEntries.find(e =>
            String(e.team?.id) === String(team.teamId) ||
            e.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase() ||
            e.team?.abbreviation === team.espnAbbr
          );
          if (found) { myConf = conf; myTeamEntry = found; break; }
        }
        if (!myConf || !myTeamEntry) return;

        const allEntries = myConf.standings?.entries || (myConf.children || []).flatMap(d => d.standings?.entries || []);
        const standings = allEntries.map(e => {
          const pts = e.stats?.find(s => s.name === "points")?.value || 0;
          const gp = e.stats?.find(s => s.name === "gamesPlayed")?.value || 0;
          const w = e.stats?.find(s => s.name === "wins")?.value || 0;
          const l = e.stats?.find(s => s.name === "losses")?.value || 0;
          const otl = e.stats?.find(s => s.name === "otLosses")?.value || 0;
          const remaining = 82 - gp;
          const ptPct = gp > 0 ? (w * 2 + otl) / (gp * 2) : 0.5;
          const isUs = e === myTeamEntry;
          return { team: e.team?.abbreviation, displayName: e.team?.displayName, pts, gp, w, l, otl, remaining, ptPct, isUs };
        }).sort((a, b) => b.pts - a.pts);

        const myIdx = standings.findIndex(t => t.isUs);
        const myTeam = standings[myIdx];
        setRank(myIdx + 1);
        setConfTeams(standings.slice(0, 10));

        // Monte Carlo-ish estimate using points pace
        // For each team, project final points using their current pt%
        const projections = standings.map(t => ({
          ...t,
          projPts: Math.round(t.pts + t.remaining * t.ptPct * 2),
        }));
        projections.sort((a, b) => b.projPts - a.projPts);
        const projRank = projections.findIndex(t => t.isUs) + 1;
        const myProj = projections.find(t => t.isUs);

        // Cutline: 8th place team projected points
        const cutlineProj = projections[7]?.projPts || 90;
        const buffer = myProj.projPts - cutlineProj;

        // Calculate probability based on buffer above/below cutline and remaining variance
        // Each remaining game has ~1.1 pts expected, variance matters with more games left
        const variance = Math.sqrt(myTeam.remaining) * 2.5;
        let prob;
        if (variance < 0.1) {
          prob = myIdx < 8 ? 99 : 1;
        } else {
          // Use a sigmoid-like function centered on the cutline
          prob = Math.round(100 / (1 + Math.exp(-buffer / (variance * 0.4))));
        }
        prob = Math.min(99, Math.max(1, prob));
        setOdds(prob);
      } catch (e) {
        console.error("Playoff odds error:", e);
      }
    })();
  }, [team]);

  if (odds === null) return <div style={{ padding: 20, color: "#555" }}>Calculating playoff odds...</div>;

  const radius = 50, stroke = 10;
  const circ = 2 * Math.PI * radius;
  const progress = (odds / 100) * circ;

  return (
    <div style={{ padding: "12px 0" }}>
      <div style={subheaderStyle}>Stanley Cup Playoff Probability</div>
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <svg width="120" height="120" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={radius} fill="none" stroke="#1a1a2e" strokeWidth={stroke} />
          <circle cx="60" cy="60" r={radius} fill="none" stroke={accent} strokeWidth={stroke}
            strokeDasharray={`${progress} ${circ - progress}`}
            strokeLinecap="round" transform="rotate(-90 60 60)"
            style={{ transition: "stroke-dasharray 1s ease" }}
          />
          <text x="60" y="55" textAnchor="middle" fill="white" fontSize="26" fontWeight="bold">{odds}%</text>
          <text x="60" y="72" textAnchor="middle" fill="#888" fontSize="10">PLAYOFF</text>
        </svg>
        <div>
          <div style={{ color: "#ccc", fontSize: 13, lineHeight: 1.5, marginBottom: 4 }}>
            Currently <span style={{ color: "#fff", fontWeight: 700 }}>{rank ? `#${rank}` : "--"}</span> in the Western Conference.
            {rank && rank <= 8 ? " In a playoff spot." : " Outside the playoff picture."}
          </div>
          <div style={{ fontSize: 11, color: "#666", marginBottom: 6 }}>
            Based on current pace vs. conference standings. Updates with every game.
          </div>
          <div style={{
            color: odds > 90 ? "#4CAF50" : odds > 70 ? "#8BC34A" : odds > 50 ? "#FFC107" : odds > 30 ? "#FF9800" : "#f44336",
            fontSize: 15, fontWeight: 700,
          }}>
            {odds > 95 ? "Clinched / Near Clinch" : odds > 85 ? "Very Likely" : odds > 70 ? "Strong Contender" : odds > 50 ? "In the Hunt" : odds > 30 ? "Bubble Team" : "Longshot"}
          </div>
        </div>
      </div>
      {/* Mini standings */}
      {confTeams.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 10, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Conference Standings</div>
          {confTeams.map((t, i) => (
            <div key={t.team} style={{
              display: "flex", alignItems: "center", gap: 8, padding: "4px 8px",
              fontSize: 11, borderRadius: 4,
              background: t.isUs ? accent + "18" : i === 7 ? "#ffffff08" : "transparent",
              borderLeft: t.isUs ? `3px solid ${accent}` : i === 7 ? "3px solid #ffffff22" : "3px solid transparent",
              color: t.isUs ? "#fff" : i < 8 ? "#aaa" : "#555",
              fontWeight: t.isUs ? 700 : 400,
            }}>
              <span style={{ width: 18, textAlign: "right", color: i < 8 ? "#888" : "#444" }}>{i + 1}</span>
              <span style={{ flex: 1 }}>{t.team}</span>
              <span style={{ width: 30, textAlign: "right" }}>{t.pts} pts</span>
              <span style={{ width: 55, textAlign: "right", color: "#555" }}>{t.w}-{t.l}-{t.otl}</span>
            </div>
          ))}
          <div style={{ fontSize: 9, color: "#444", marginTop: 4, paddingLeft: 8 }}>— Top 8 qualify for playoffs —</div>
        </div>
      )}
    </div>
  );
}

// --- News Tab ---
function NewsTab({ team, accent }) {
  const [articles, setArticles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Derive league news path from apiTeam: "sports/hockey/nhl/teams/uta" -> "sports/hockey/nhl/news"
        const newsPath = team.apiTeam.replace(/\/teams\/.*$/, "/news");
        const data = await fetchESPN(newsPath, false, { limit: 50 });
        const allArticles = data?.articles || [];

        // Filter articles that mention this team by teamId or name in categories
        const teamId = String(team.teamId);
        const teamName = team.name.toLowerCase();
        const shortName = (team.shortName || "").toLowerCase();
        const espnAbbr = (team.espnAbbr || "").toLowerCase();
        const filtered = allArticles.filter((article) => {
          const cats = article.categories || [];
          for (const cat of cats) {
            if (cat.type === "team") {
              // Match by numeric teamId (works for most teams)
              if (String(cat.teamId) === teamId) return true;
              // Match by team.id inside the category (covers both numeric and string IDs)
              if (cat.team && String(cat.team.id) === teamId) return true;
              // Match by team description (handles cases like Mammoth where config teamId is "uta" but ESPN uses 129764)
              const catDesc = (cat.description || "").toLowerCase();
              if (shortName && shortName.length > 2 && catDesc.includes(shortName)) return true;
              // Match by ESPN abbreviation in the team links URL
              const teamUrl = cat.team?.links?.web?.teams?.href || "";
              if (espnAbbr && teamUrl.toLowerCase().includes(`/name/${espnAbbr.toLowerCase()}/`)) return true;
            }
          }
          // Fallback: check headline/description for team name
          const headline = (article.headline || "").toLowerCase();
          const desc = (article.description || "").toLowerCase();
          if (shortName && shortName.length > 3 && (headline.includes(shortName) || desc.includes(shortName))) return true;
          return false;
        });

        if (!cancelled) {
          setArticles(filtered.slice(0, 10));
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e.message);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [team.apiTeam, team.teamId, team.name, team.shortName]);

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, gap: 10 }}>
        <div style={{
          width: 20, height: 20,
          border: `3px solid ${accent}33`, borderTop: `3px solid ${accent}`,
          borderRadius: "50%", animation: "spin 1s linear infinite",
        }} />
        <span style={{ color: "#888", fontSize: 13 }}>Loading news...</span>
      </div>
    );
  }

  if (error) {
    return <div style={{ color: "#f44336", padding: 16, textAlign: "center", fontSize: 13 }}>Unable to load news</div>;
  }

  if (!articles || articles.length === 0) {
    return <div style={{ color: "#777", padding: 16, textAlign: "center", fontSize: 13 }}>No recent news for {team.shortName || team.name}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {articles.map((article, i) => {
        const img = article.images?.[0]?.url;
        const published = article.published ? new Date(article.published) : null;
        const timeAgo = published ? getTimeAgo(published) : "";
        const link = article.links?.web?.href || article.links?.api?.news?.href || "#";

        return (
          <a
            key={article.headline + i}
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex", alignItems: "flex-start", gap: 12,
              padding: "10px 8px",
              background: i % 2 === 0 ? "#1a1a2e" : "transparent",
              borderRadius: 8, textDecoration: "none",
              transition: "background 0.2s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = accent + "18"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = i % 2 === 0 ? "#1a1a2e" : "transparent"; }}
          >
            {img && (
              <img
                src={img}
                alt=""
                style={{
                  width: 72, height: 48, borderRadius: 6,
                  objectFit: "cover", flexShrink: 0,
                  background: "#2a2a3e",
                }}
                onError={(e) => { e.target.style.display = "none"; }}
              />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                color: "#eee", fontSize: 13, fontWeight: 600,
                lineHeight: 1.35, marginBottom: 4,
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}>
                {article.headline}
              </div>
              {article.description && (
                <div style={{
                  color: "#888", fontSize: 11, lineHeight: 1.4,
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}>
                  {article.description}
                </div>
              )}
              {timeAgo && (
                <div style={{ color: "#666", fontSize: 10, marginTop: 4 }}>{timeAgo}</div>
              )}
            </div>
          </a>
        );
      })}
    </div>
  );
}

function getTimeAgo(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// --- Quick Links---
function QuickLinks({ team, accent }) {
  const btnBase = {
    flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: "10px 12px", background: "#1a1a2e", border: `1px solid ${accent}44`,
    borderRadius: 8, color: "#eee", textDecoration: "none", fontSize: 12, fontWeight: 600,
    cursor: "pointer", transition: "all 0.2s",
  };
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
      <a href={team.espnUrl} target="_blank" rel="noopener noreferrer" style={btnBase}
        onMouseEnter={(e) => { e.currentTarget.style.background = accent + "33"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a2e"; }}
      ><span style={{display:"inline-flex",alignItems:"center",gap:4}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg> Watch on ESPN</span></a>
      <a href={team.ticketUrl} target="_blank" rel="noopener noreferrer" style={btnBase}
        onMouseEnter={(e) => { e.currentTarget.style.background = accent + "33"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "#1a1a2e"; }}
      ><span style={{display:"inline-flex",alignItems:"center",gap:4}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 9a3 3 0 013-3h14a3 3 0 013 3v0a3 3 0 01-3 3v0a3 3 0 013 3v0a3 3 0 01-3 3H5a3 3 0 01-3-3v0a3 3 0 013-3v0a3 3 0 01-3-3z"/></svg> Buy Tickets</span></a>
    </div>
  );
}

// --- Team Widget---
function TeamWidget({ team, isDragging, dragHandlers }) {
  const { schedule, standings, record, loading, error } = useTeamData(team);
  const { roster, rosterLoading } = useRosterData(team);

  const tabs = [
    { label: "Schedule", content: <ScheduleTab schedule={schedule} accent={team.accent} /> },
    { label: "Standings", content: <StandingsTab standings={standings} accent={team.accent} team={team} /> },
  ];
  tabs.push({ label: "Roster", content: rosterLoading ?
    <div style={{ color: "#888", padding: 20, textAlign: "center" }}>Loading roster...</div> :
    <RosterTab roster={roster} accent={team.accent} team={team} />
  });
  tabs.push({ label: "Stats", content: <StatsTab team={team} accent={team.accent} /> });
  tabs.push({ label: "News", content: <NewsTab team={team} accent={team.accent} /> });
  if (team.showPlayoffOdds) {
    tabs.push({ label: "Playoff Odds", content: <PlayoffOddsTab team={team} accent={team.accent} /> });
  }

  return (
    <div draggable {...dragHandlers} style={{
      background: "#12121f",
      border: isDragging ? `2px solid ${team.accent}` : "1px solid #2a2a3e",
      borderRadius: 14, padding: 0, cursor: "grab",
      opacity: isDragging ? 0.6 : 1, transition: "all 0.25s ease",
      boxShadow: isDragging ? `0 12px 40px ${team.accent}33` : "0 4px 20px rgba(0,0,0,0.3)",
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        background: `linear-gradient(135deg, ${team.accent}22 0%, #12121f 100%)`,
        borderBottom: `1px solid ${team.accent}33`, padding: "14px 18px",
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <div style={{ cursor: "grab", color: "#555", fontSize: 18, userSelect: "none", lineHeight: 1 }}><svg width="18" height="18" viewBox="0 0 24 24" fill="#555"><circle cx="8" cy="4" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="20" r="2"/><circle cx="16" cy="20" r="2"/></svg></div>
        <img src={team.logo} alt={team.name}
          style={{ width: 44, height: 44, borderRadius: 8, background: "#fff", objectFit: "contain", padding: 3 }}
          onError={(e) => { e.target.style.display = "none"; }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ color: "#fff", fontSize: 16, fontWeight: 700 }}>{team.name}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
            <span style={{ color: team.accent, fontSize: 13, fontWeight: 600 }}>{record}</span>
            <span style={{
              background: team.accent + "22", color: team.accent, fontSize: 9,
              padding: "2px 6px", borderRadius: 4, fontWeight: 700,
            }}>{team.leagueTag}</span>
            {schedule?.some((g) => g.status === "live") && (
              <span style={{
                background: "#CC0000", color: "#fff", fontSize: 9, fontWeight: 800,
                padding: "2px 6px", borderRadius: 4, letterSpacing: 0.5,
                animation: "liveBlink 1.5s ease-in-out infinite",
              }}>LIVE</span>
            )}
            {error && <span style={{ color: "#f44336", fontSize: 10 }}>! {error}</span>}
          </div>
          <div style={{ color: "#666", fontSize: 11, marginTop: 1, display: "flex", alignItems: "center", gap: 3 }}><svg width="11" height="11" viewBox="0 0 24 24" fill="#666" stroke="none"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> {team.venue}</div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: "12px 18px 16px" }}>
        {loading ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200, gap: 10 }}>
            <div style={{
              width: 24, height: 24,
              border: `3px solid ${team.accent}33`, borderTop: `3px solid ${team.accent}`,
              borderRadius: "50%", animation: "spin 1s linear infinite",
            }} />
            <span style={{ color: "#888", fontSize: 13 }}>Fetching live data...</span>
          </div>
        ) : (
          <Tabs tabs={tabs} accent={team.accent} />
        )}
        <QuickLinks team={team} accent={team.accent} />
      </div>
    </div>
  );
}

// --- Shared Styles---
const subheaderStyle = {
  fontSize: 11, color: "#888", textTransform: "uppercase",
  letterSpacing: 1, marginBottom: 6, fontWeight: 600,
};
const rowStyle = (i) => ({
  display: "flex", justifyContent: "space-between", alignItems: "center",
  padding: "8px 10px", background: i % 2 === 0 ? "#1a1a2e" : "transparent",
  borderRadius: 6, marginBottom: 2,
});
const thStyle = { textAlign: "center", padding: "4px 6px", fontWeight: 600 };
const tdStyle = { padding: "6px", color: "#ccc", textAlign: "center" };

// --- Team Picker Modal ---
const MAX_TEAMS = 8;

const PICKER_TABS = [
  { key: "NFL", label: "NFL" },
  { key: "MLB", label: "MLB" },
  { key: "NBA", label: "NBA" },
  { key: "NCAAF", label: "NCAA FB" },
  { key: "NCAAM", label: "NCAA MB" },
  { key: "NHL", label: "NHL" },
];

function TeamPickerModal({ selectedTeams, onSave, onClose, isFirstTime }) {
  const [picked, setPicked] = useState(selectedTeams || []);
  const [activeTab, setActiveTab] = useState("NFL");
  const [search, setSearch] = useState("");
  const [confFilter, setConfFilter] = useState("All");

  // Get unique conferences for the active tab
  const conferences = ["All", ...Array.from(new Set(
    TEAMS_CONFIG.filter((t) => t.leagueTag === activeTab).map((t) => t.conference).filter(Boolean)
  )).sort()];

  const toggle = (id) => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_TEAMS) return prev; // enforce cap
      return [...prev, id];
    });
  };

  const canSave = picked.length >= 1 && picked.length <= MAX_TEAMS;
  const filteredTeams = TEAMS_CONFIG.filter((t) => {
    const matchesTab = t.leagueTag === activeTab;
    const matchesSearch = search.trim() === "" || t.name.toLowerCase().includes(search.toLowerCase()) || t.shortName.toLowerCase().includes(search.toLowerCase()) || t.venue.toLowerCase().includes(search.toLowerCase());
    const matchesConf = confFilter === "All" || t.conference === confFilter;
    return matchesTab && matchesSearch && matchesConf;
  });

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }} onClick={(e) => { if (!isFirstTime && e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 16,
        padding: "28px 24px", maxWidth: 560, width: "100%", maxHeight: "90vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h2 style={{ color: "#fff", margin: "0 0 6px", fontSize: 20, fontWeight: 700 }}>
            {isFirstTime ? "Welcome! Pick Your Teams" : "Customize Your Dashboard"}
          </h2>
          {!isFirstTime && (
            <button onClick={onClose} style={{
              background: "none", border: "none", cursor: "pointer", padding: 4,
              color: "#666", fontSize: 20, lineHeight: 1, borderRadius: 6,
            }} title="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          )}
        </div>
        <p style={{ color: "#888", fontSize: 13, margin: "0 0 14px" }}>
          Select up to {MAX_TEAMS} teams to follow. {picked.length}/{MAX_TEAMS} selected.
        </p>

        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", flexShrink: 0 }}>
          {PICKER_TABS.map((tab) => (
            <button key={tab.key} onClick={() => { setActiveTab(tab.key); setSearch(""); setConfFilter("All"); }} style={{
              padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              fontSize: 12, fontWeight: 600, transition: "all 0.2s",
              background: activeTab === tab.key ? "#fff" : "#2a2a3e",
              color: activeTab === tab.key ? "#12121f" : "#999",
            }}>{tab.label}</button>
          ))}
        </div>

        <input
          type="text"
          placeholder="Search teams..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%", padding: "8px 12px", marginBottom: 8, borderRadius: 8,
            border: "1px solid #2a2a3e", background: "#1a1a2e", color: "#eee",
            fontSize: 13, outline: "none", boxSizing: "border-box",
          }}
        />

        {conferences.length > 2 && (
          <div style={{ position: "relative", marginBottom: 8 }}>
            <select
              value={confFilter}
              onChange={(e) => setConfFilter(e.target.value)}
              style={{
                width: "100%", padding: "10px 36px 10px 12px", borderRadius: 8,
                border: "1px solid #2a2a3e", background: "#1a1a2e", color: "#ccc",
                fontSize: 13, outline: "none", boxSizing: "border-box",
                cursor: "pointer", height: 42, lineHeight: "20px",
                WebkitAppearance: "none", MozAppearance: "none", appearance: "none",
              }}
            >
              {conferences.map((c) => (
                <option key={c} value={c}>{c === "All" ? "All Conferences" : c}</option>
              ))}
            </select>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5" strokeLinecap="round" style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", minHeight: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {filteredTeams.map((team) => {
              const isSelected = picked.includes(team.id);
              const isDisabled = !isSelected && picked.length >= MAX_TEAMS;
              return (
                <div key={team.id} onClick={() => !isDisabled && toggle(team.id)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
                  borderRadius: 10, cursor: isDisabled ? "not-allowed" : "pointer",
                  border: isSelected ? `2px solid ${team.accent}` : "2px solid #2a2a3e",
                  background: isSelected ? team.accent + "15" : "#1a1a2e",
                  opacity: isDisabled ? 0.4 : 1, transition: "all 0.2s",
                  minWidth: 0, overflow: "hidden",
                }}>
                  <img src={team.logo} alt="" style={{ width: 30, height: 30, borderRadius: 5, objectFit: "contain", background: "#fff", padding: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: isSelected ? team.accent : "#ccc", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{team.name.replace(/ Football$| Basketball$/, "")}</div>
                  </div>
                  <div style={{
                    width: 20, height: 20, borderRadius: 5,
                    border: isSelected ? `2px solid ${team.accent}` : "2px solid #444",
                    background: isSelected ? team.accent : "transparent",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    {isSelected && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "flex-end", flexShrink: 0 }}>
          {!isFirstTime && (
            <button onClick={onClose} style={{
              background: "none", border: "1px solid #444", borderRadius: 8,
              padding: "10px 20px", color: "#888", fontSize: 13, cursor: "pointer",
            }}>Cancel</button>
          )}
          <button onClick={() => canSave && onSave(picked)} disabled={!canSave} style={{
            background: canSave ? "#CC0000" : "#333", border: "none", borderRadius: 8,
            padding: "10px 24px", color: canSave ? "#fff" : "#666", fontSize: 13,
            fontWeight: 600, cursor: canSave ? "pointer" : "not-allowed", transition: "all 0.2s",
          }}>
            {isFirstTime ? `Let's Go (${picked.length})` : `Save (${picked.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Main Dashboard---
export default function App() {
  const { user, profile, authLoading, loginWithGoogle, signupWithEmail, loginWithEmail, logout, isAdmin, refreshProfile } = useAuth();
  const [showBracket, setShowBracket] = useState(false);
  const [bracketEntry, setBracketEntry] = useState(1);
  const [userEntries, setUserEntries] = useState([null, null]);
  const [order, setOrder] = useState([]);
  const [selectedTeams, setSelectedTeams] = useState(null); // null = not loaded yet
  const [showTeamPicker, setShowTeamPicker] = useState(false);
  const [teamsLoaded, setTeamsLoaded] = useState(false);
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [bracketInitialTab, setBracketInitialTab] = useState("bracket");
  const [showAdmin, setShowAdmin] = useState(false);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showTosModal, setShowTosModal] = useState(false);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // If Google user signs in without a username, they need to set one
  const needsUsername = user && profile && !profile.username;

  // Load team preferences: Firebase for logged-in users, localStorage for guests
  useEffect(() => {
    if (!user) {
      // Guest: load from localStorage
      try {
        const saved = localStorage.getItem("scs_selectedTeams");
        if (saved) {
          const parsed = JSON.parse(saved);
          const valid = parsed.filter(id => TEAMS_CONFIG.find(t => t.id === id));
          if (valid.length > 0) {
            setSelectedTeams(valid);
            setOrder(valid);
          } else {
            setSelectedTeams([]);
            setShowTeamPicker(true);
          }
        } else {
          // First visit — show default teams but prompt to customize
          setSelectedTeams(["mammoth", "jazz", "utes-football", "utes-basketball"]);
          setOrder(["mammoth", "jazz", "utes-football", "utes-basketball"]);
        }
      } catch {
        setSelectedTeams(["mammoth", "jazz", "utes-football", "utes-basketball"]);
        setOrder(["mammoth", "jazz", "utes-football", "utes-basketball"]);
      }
      setTeamsLoaded(true);
      return;
    }
    // Logged-in: load from Firebase
    (async () => {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.exists() ? snap.data() : {};
        if (data.selectedTeams && data.selectedTeams.length > 0) {
          const valid = data.selectedTeams.filter(id => TEAMS_CONFIG.find(t => t.id === id));
          setSelectedTeams(valid);
          setOrder(valid);
        } else {
          // Check if guest had localStorage prefs to migrate
          try {
            const local = localStorage.getItem("scs_selectedTeams");
            if (local) {
              const parsed = JSON.parse(local);
              const valid = parsed.filter(id => TEAMS_CONFIG.find(t => t.id === id));
              if (valid.length > 0) {
                setSelectedTeams(valid);
                setOrder(valid);
                await setDoc(doc(db, "users", user.uid), { selectedTeams: valid }, { merge: true });
                localStorage.removeItem("scs_selectedTeams");
                setTeamsLoaded(true);
                return;
              }
            }
          } catch {}
          // First-time user — show team picker
          setSelectedTeams([]);
          setShowTeamPicker(true);
        }
      } catch (e) {
        console.error("Failed to load team prefs:", e);
        setSelectedTeams([]);
        setShowTeamPicker(true);
      }
      setTeamsLoaded(true);
    })();
  }, [user]);

  // Save team preferences: Firebase for logged-in users, localStorage for guests
  const saveTeamPrefs = async (teams) => {
    setSelectedTeams(teams);
    setOrder(teams);
    if (!user) {
      // Guest: save to localStorage
      try { localStorage.setItem("scs_selectedTeams", JSON.stringify(teams)); } catch {}
      return;
    }
    try {
      await setDoc(doc(db, "users", user.uid), { selectedTeams: teams }, { merge: true });
    } catch (e) {
      console.error("Failed to save team prefs:", e);
    }
  };

  // Load user bracket entries for banner display
  useEffect(() => {
    if (user) {
      loadUserEntries(user.uid).then(setUserEntries);
    } else {
      setUserEntries([null, null]);
    }
  }, [user, showBracket]); // re-fetch when returning from bracket

  // Auto-update the "last refresh" display every minute
  useEffect(() => {
    const t = setInterval(() => setLastRefresh(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const handleDragStart = useCallback((e, id) => {
    setDraggedId(id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", id);
  }, []);
  const handleDragOver = useCallback((e, id) => { e.preventDefault(); setDragOverId(id); }, []);
  const handleDrop = useCallback((e, targetId) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId) { setDraggedId(null); setDragOverId(null); return; }
    setOrder((prev) => {
      const n = [...prev]; const si = n.indexOf(draggedId); const ti = n.indexOf(targetId);
      n.splice(si, 1); n.splice(ti, 0, draggedId);
      // Persist reorder
      if (user) {
        setDoc(doc(db, "users", user.uid), { selectedTeams: n }, { merge: true }).catch(() => {});
      } else {
        try { localStorage.setItem("scs_selectedTeams", JSON.stringify(n)); } catch {}
      }
      return n;
    });
    setDraggedId(null); setDragOverId(null);
  }, [draggedId, user]);
  const handleDragEnd = useCallback(() => { setDraggedId(null); setDragOverId(null); }, []);

  // Load admin users + bracket data
  const loadAdminUsers = async () => {
    setAdminLoading(true);
    try {
      // Fetch both collections in parallel
      const [usersSnap, bracketsSnap] = await Promise.all([
        getDocs(query(collection(db, "users"), orderBy("lastLogin", "desc"))),
        getDocs(collection(db, "brackets")),
      ]);

      // Build bracket map keyed by ownerUid
      const bracketsByUser = {};
      bracketsSnap.docs.forEach((d) => {
        const b = d.data();
        const uid = b.ownerUid || d.id;
        if (!bracketsByUser[uid]) bracketsByUser[uid] = [];
        bracketsByUser[uid].push({
          entryNum: b.entryNum || 1,
          entryName: b.entryName || "",
          picks: b.picks || {},
          updatedAt: b.updatedAt || null,
          champion: b.picks?.champ || null,
          displayName: b.displayName || "Anonymous",
          photoURL: b.photoURL || null,
          email: b.email || null,
        });
      });

      // Build user map from "users" collection
      const userMap = {};
      usersSnap.docs.forEach((d) => {
        const u = d.data();
        userMap[u.uid] = {
          ...u,
          displayName: u.username || u.displayName || "Anonymous",
          brackets: bracketsByUser[u.uid] || [],
        };
      });

      // Add bracket-only users (submitted a bracket but no Firestore profile)
      for (const uid of Object.keys(bracketsByUser)) {
        if (!userMap[uid]) {
          const first = bracketsByUser[uid][0];
          userMap[uid] = {
            uid,
            displayName: first.displayName,
            email: first.email,
            photoURL: first.photoURL,
            lastLogin: first.updatedAt,
            brackets: bracketsByUser[uid],
            bracketOnly: true,
          };
        }
      }

      // Sort: users with brackets first, then by last login
      const allUsers = Object.values(userMap).sort((a, b) => {
        const aHas = a.brackets.length > 0 ? 1 : 0;
        const bHas = b.brackets.length > 0 ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        return new Date(b.lastLogin || 0) - new Date(a.lastLogin || 0);
      });

      setAdminUsers(allUsers);
    } catch (e) {
      console.error("Admin load error:", e);
    }
    setAdminLoading(false);
  };

  // Show Bracket Challenge if active
  if (showBracket) {
    return (
      <>
        <BracketChallenge user={user} onBack={() => { setShowBracket(false); setBracketInitialTab("bracket"); }} initialEntry={bracketEntry} initialTab={bracketInitialTab} onSignIn={() => setShowAuthModal(true)} />
        {showAuthModal && (
          <AuthModal
            onClose={() => setShowAuthModal(false)}
            onLoginGoogle={loginWithGoogle}
            onSignupEmail={signupWithEmail}
            onLoginEmail={loginWithEmail}
          />
        )}
      </>
    );
  }

  // Show Admin Panel
  if (showAdmin && isAdmin) {
    const totalUsers = adminUsers.length;
    const usersWithBrackets = adminUsers.filter((u) => u.brackets.length > 0).length;
    const totalBrackets = adminUsers.reduce((sum, u) => sum + u.brackets.length, 0);
    const signUpOnly = totalUsers - usersWithBrackets;

    return (
      <div style={{
        minHeight: "100vh",
        background: "linear-gradient(180deg, #0a0a16 0%, #0f0f1e 50%, #0a0a16 100%)",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "#fff",
      }}>
        <style>{`@media (max-width: 768px) { .ush-admin-title-block { display: none !important; } }`}</style>
        <header style={{
          background: "linear-gradient(135deg, #12121f 0%, #1a1a30 100%)",
          borderBottom: "1px solid #2a2a3e", padding: "14px 20px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={() => setShowAdmin(false)} style={{
              background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
              padding: "6px 12px", color: "#888", fontSize: 12, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 4,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Back
            </button>
            <div className="ush-admin-title-block">
              <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: -0.5 }}>
                Salt City Sports <span style={{ color: "#CC0000" }}>Admin</span>
              </h1>
              <p style={{ margin: 0, fontSize: 10, color: "#666" }}>USER MANAGEMENT</p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={async () => {
              if (!window.confirm("Delete ALL chat messages? This cannot be undone.")) return;
              const snap = await getDocs(collection(db, "bracketChat"));
              for (const d of snap.docs) await deleteDoc(doc(db, "bracketChat", d.id));
              alert(`Deleted ${snap.size} messages.`);
            }} style={{
              background: "#CC000015", border: "1px solid #CC000044", borderRadius: 8,
              padding: "6px 12px", color: "#CC0000", fontSize: 11, cursor: "pointer",
            }}>Clear Chat</button>
            <button onClick={async () => {
              if (!window.confirm("Delete ALL bracket entries? This cannot be undone.")) return;
              const snap = await getDocs(collection(db, "brackets"));
              for (const d of snap.docs) await deleteDoc(doc(db, "brackets", d.id));
              alert(`Deleted ${snap.size} bracket entries.`);
              loadAdminUsers();
            }} style={{
              background: "#CC000015", border: "1px solid #CC000044", borderRadius: 8,
              padding: "6px 12px", color: "#CC0000", fontSize: 11, cursor: "pointer",
            }}>Clear Brackets</button>
            <button onClick={loadAdminUsers} style={{
              background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 8,
              padding: "6px 12px", color: "#888", fontSize: 11, cursor: "pointer",
            }}>Refresh</button>
          </div>
        </header>

        <main style={{ padding: 20, maxWidth: 1000, margin: "0 auto" }}>
          {/* Stats Cards */}
          {!adminLoading && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total Users", value: totalUsers, color: "#4A90D9" },
                { label: "With Brackets", value: usersWithBrackets, color: "#4CAF50" },
                { label: "Total Brackets", value: totalBrackets, color: "#FF6B35" },
                { label: "Sign-Up Only", value: signUpOnly, color: "#888" },
              ].map((stat) => (
                <div key={stat.label} style={{
                  background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 10,
                  padding: "14px 16px", textAlign: "center",
                }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: stat.color }}>{stat.value}</div>
                  <div style={{ fontSize: 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>{stat.label}</div>
                </div>
              ))}
            </div>
          )}

          {adminLoading ? (
            <div style={{ textAlign: "center", padding: 60, color: "#555" }}>Loading users...</div>
          ) : adminUsers.length === 0 ? (
            <div style={{ textAlign: "center", padding: 60, color: "#555" }}>No users registered yet.</div>
          ) : (
            <div style={{ background: "#12121f", borderRadius: 12, overflow: "hidden", border: "1px solid #2a2a3e" }}>
              {/* Table Header */}
              <div style={{
                display: "grid", gridTemplateColumns: "36px 1fr 1fr 100px 1fr 60px",
                padding: "10px 16px", borderBottom: "1px solid #2a2a3e",
                fontSize: 10, color: "#666", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700,
              }}>
                <div>#</div>
                <div>User</div>
                <div>Email</div>
                <div style={{ textAlign: "center" }}>Brackets</div>
                <div>Last Active</div>
                <div></div>
              </div>

              {adminUsers.map((u, i) => {
                const hasBrackets = u.brackets.length > 0;
                return (
                  <div key={u.uid}>
                    {/* User Row */}
                    <div style={{
                      display: "grid", gridTemplateColumns: "36px 1fr 1fr 100px 1fr 60px",
                      padding: "10px 16px", borderBottom: hasBrackets ? "none" : "1px solid #1a1a2e",
                      background: i % 2 === 0 ? "#0f0f1e" : "transparent",
                      alignItems: "center",
                    }}>
                      <div style={{ color: "#888", fontWeight: 700, fontSize: 12 }}>{i + 1}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        {u.photoURL ? (
                          <img src={u.photoURL} alt="" referrerPolicy="no-referrer"
                            style={{ width: 26, height: 26, borderRadius: "50%", border: "1px solid #333", flexShrink: 0 }}
                          />
                        ) : (
                          <div style={{
                            width: 26, height: 26, borderRadius: "50%", background: "#2a2a3e",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontSize: 11, color: "#888", fontWeight: 700, flexShrink: 0,
                          }}>
                            {(u.displayName || "?")[0].toUpperCase()}
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {u.displayName || "Anonymous"}
                          </div>
                          {u.bracketOnly && (
                            <div style={{ fontSize: 9, color: "#FF6B35" }}>pre-registration</div>
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {u.email || "—"}
                      </div>
                      <div style={{ textAlign: "center" }}>
                        {hasBrackets ? (
                          <span style={{
                            background: "#4CAF5022", color: "#4CAF50", fontSize: 11, fontWeight: 700,
                            padding: "2px 10px", borderRadius: 10, border: "1px solid #4CAF5044",
                          }}>
                            {u.brackets.length}
                          </span>
                        ) : (
                          <span style={{ fontSize: 11, color: "#444" }}>—</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: "#666" }}>
                        {u.lastLogin ? new Date(u.lastLogin).toLocaleDateString("en-US", {
                          month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                        }) : "—"}
                      </div>
                      <div style={{ textAlign: "center" }}>
                        {u.uid !== user?.uid && (
                          <button onClick={async () => {
                            if (!window.confirm(`Delete ${u.displayName || u.email}? This removes their Firestore profile and brackets.`)) return;
                            try {
                              await deleteDoc(doc(db, "users", u.uid));
                              const bSnap = await getDocs(collection(db, "brackets"));
                              for (const d of bSnap.docs) {
                                if (d.data().ownerUid === u.uid) await deleteDoc(doc(db, "brackets", d.id));
                              }
                              loadAdminUsers();
                            } catch (e) { alert("Error: " + e.message); }
                          }} style={{
                            background: "transparent", border: "1px solid #CC000044", borderRadius: 6,
                            padding: "3px 8px", color: "#CC0000", fontSize: 10, cursor: "pointer",
                            opacity: 0.6, transition: "opacity 0.2s",
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
                          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
                          title="Delete user from Firestore"
                          >Delete</button>
                        )}
                      </div>
                    </div>

                    {/* Bracket Details (inline, beneath the user row) */}
                    {hasBrackets && (
                      <div style={{
                        padding: "0 16px 10px 52px",
                        background: i % 2 === 0 ? "#0f0f1e" : "transparent",
                        borderBottom: "1px solid #1a1a2e",
                      }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {u.brackets.map((b, bi) => {
                            const numPicks = Object.keys(b.picks || {}).filter((k) => b.picks[k]).length;
                            const champName = b.champion && b.picks[b.champion] ? null : null; // just use champion ID
                            return (
                              <div key={bi} style={{
                                background: "#0a0a16", border: "1px solid #2a2a3e", borderRadius: 8,
                                padding: "6px 12px", fontSize: 10, color: "#888",
                                display: "flex", alignItems: "center", gap: 8,
                              }}>
                                <div style={{
                                  width: 6, height: 6, borderRadius: "50%",
                                  background: numPicks === 67 ? "#4CAF50" : numPicks > 0 ? "#FF6B35" : "#444",
                                }} />
                                <div>
                                  <span style={{ fontWeight: 600, color: "#ccc" }}>
                                    {b.entryName || `Entry ${b.entryNum}`}
                                  </span>
                                  <span style={{ color: "#555", marginLeft: 6 }}>
                                    {numPicks}/67 picks
                                  </span>
                                  {b.champion && (
                                    <span style={{ color: "#FFD700", marginLeft: 6 }}>
                                      Champ: {b.champion}
                                    </span>
                                  )}
                                </div>
                                {b.updatedAt && (
                                  <div style={{ fontSize: 9, color: "#444", marginLeft: 4 }}>
                                    {new Date(b.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </main>
      </div>
    );
  }

  const hasAnyBracket = userEntries.some((e) => e && Object.keys(e.picks || {}).length > 0);
  const entry1 = userEntries[0];
  const entry2 = userEntries[1];
  const entry1Picks = entry1 ? Object.keys(entry1.picks || {}).length : 0;
  const entry2Picks = entry2 ? Object.keys(entry2.picks || {}).length : 0;

  return (
    <div style={{
      minHeight: "100vh",
      background: "linear-gradient(180deg, #0a0a16 0%, #0f0f1e 50%, #0a0a16 100%)",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: "#fff",
    }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes livePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.85; } }
        @keyframes liveBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes bannerShimmer { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
        .mm-banner {
          width: 100%;
          background: linear-gradient(135deg, #FF6B35 0%, #CC0000 40%, #8B0000 70%, #FF6B35 100%);
          background-size: 200% 200%;
          animation: bannerShimmer 4s ease infinite;
          border: none; border-radius: 14px;
          padding: 16px 24px;
          cursor: pointer; transition: transform 0.2s, box-shadow 0.2s;
          display: flex; align-items: center; justify-content: space-between;
          box-shadow: 0 4px 20px #CC000044;
        }
        .mm-banner-content { display: flex; align-items: center; gap: 14px; }
        .mm-banner-emoji { font-size: 32px; }
        .mm-banner-title { font-size: 18px; font-weight: 900; color: #fff; letter-spacing: -0.5px; text-shadow: 0 2px 8px #00000066; }
        .mm-banner-sub { font-size: 12px; color: #ffffffcc; font-weight: 500; margin-top: 2px; }
        .mm-banner-cta {
          background: #ffffff22; backdrop-filter: blur(4px);
          border-radius: 8px; padding: 8px 18px;
          color: #fff; font-size: 13px; font-weight: 700;
          border: 1px solid #ffffff33; white-space: nowrap;
          display: flex; align-items: center; gap: 6px; flex-shrink: 0;
        }
        @media (max-width: 768px) {
          .mm-banner { flex-direction: column; gap: 12px; padding: 14px 16px; align-items: stretch; }
          .mm-banner-content { gap: 10px; }
          .mm-banner-emoji { font-size: 24px; }
          .mm-banner-title { font-size: 15px; }
          .mm-banner-sub { font-size: 11px; }
          .mm-banner-cta { justify-content: center; padding: 10px 16px; white-space: normal; min-width: 0 !important; flex: 1; }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #0a0a16; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        a:hover { filter: brightness(1.2); }
        .ush-logo { width: 52px; height: 52px; }
        .ush-title { font-size: 24px; }
        @media (max-width: 768px) {
          .ush-header > div { padding: 0 12px !important; }
          .ush-header-left { gap: 6px !important; margin-right: 12px !important; }
          .ush-header-nav { gap: 0 !important; }
          .ush-nav-link { padding: 6px 8px !important; font-size: 11px !important; color: #fff !important; }
          .ush-header-nav .ush-nav-link svg { display: none !important; }
          .ush-teams-label { display: none !important; }
          .ush-customize-teams { padding: 6px !important; border: none !important; }
          .ush-customize-teams svg { display: inline-block !important; }
          .ush-logo { width: 32px !important; height: 32px !important; }
          .ush-title { display: none !important; }
          .ush-header-left { margin-right: 8px !important; }
          .ush-grid { padding: 12px 10px 30px !important; grid-template-columns: 1fr !important; gap: 14px !important; }
          .ush-admin-title-block { display: none !important; }
        }
      `}</style>

      {/* Header - ESPN-style nav */}
      <header className="ush-header" style={{
        background: "#0a0a18", borderBottom: "1px solid #2a2a3e",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{
          display: "flex", alignItems: "center", padding: "0 24px", height: 52,
        }}>
          {/* Logo */}
          <div className="ush-header-left" style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 28 }}>
            <img className="ush-logo" src="/salt-city-sports-logo.png" alt="Salt City Sports" style={{ width: 40, height: 40, borderRadius: "50%", objectFit: "cover" }} />
            <h1 className="ush-title" style={{ margin: 0, fontWeight: 800, fontSize: 20, letterSpacing: -0.5 }}>
              <span style={{ color: "#fff" }}>Salt City </span><span style={{ color: "#CC0000" }}>Sports</span>
            </h1>
          </div>

          {/* Nav links */}
          <nav className="ush-header-nav" style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <button onClick={() => { setBracketEntry(1); setBracketInitialTab("bracket"); setShowBracket(true); }}
              className="ush-nav-link"
              style={{
                background: "none", border: "none", color: "#ccc", fontSize: 16, fontWeight: 600,
                cursor: "pointer", padding: "8px 14px", borderRadius: 6, transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#ffffff12"; e.currentTarget.style.color = "#fff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#ccc"; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93c4.08 2.14 6.16 4.22 10.14 10.14"/><path d="M19.07 4.93c-4.08 2.14-6.16 4.22-10.14 10.14"/><path d="M2 12h20"/></svg>
              March Madness
            </button>
            <button onClick={() => { setBracketEntry(1); setBracketInitialTab("lb"); setShowBracket(true); }}
              className="ush-nav-link"
              style={{
                background: "none", border: "none", color: "#ccc", fontSize: 16, fontWeight: 600,
                cursor: "pointer", padding: "8px 14px", borderRadius: 6, transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#ffffff12"; e.currentTarget.style.color = "#fff"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#ccc"; }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9H4.5a2.5 2.5 0 010-5H6"/><path d="M18 9h1.5a2.5 2.5 0 000-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 1012 0V2Z"/></svg>
              Leaderboard
            </button>
            {user && (
              <button onClick={() => { setBracketEntry(1); setBracketInitialTab("chat"); setShowBracket(true); }}
                className="ush-nav-link"
                style={{
                  background: "none", border: "none", color: "#ccc", fontSize: 16, fontWeight: 600,
                  cursor: "pointer", padding: "8px 14px", borderRadius: 6, transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#ffffff12"; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#ccc"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                Chat Room
              </button>
            )}
            {isAdmin && (
              <button onClick={() => { setShowAdmin(true); loadAdminUsers(); }}
                className="ush-nav-link"
                style={{
                  background: "none", border: "none", color: "#ccc", fontSize: 16, fontWeight: 600,
                  cursor: "pointer", padding: "8px 14px", borderRadius: 6, transition: "all 0.15s",
                  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#ffffff12"; e.currentTarget.style.color = "#fff"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#ccc"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197"/></svg>
                Admin
              </button>
            )}
          </nav>

          {/* Right side - customize teams + profile */}
          <div className="ush-header-right" style={{ display: "flex", alignItems: "center", gap: 6, position: "relative" }}>
            <button onClick={() => setShowTeamPicker(true)}
              className="ush-nav-link ush-customize-teams"
              style={{
                background: "none", border: "1px solid #ffffff18", color: "#aaa", fontSize: 14, fontWeight: 600,
                cursor: "pointer", padding: "7px 14px", borderRadius: 6, transition: "all 0.15s",
                display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#ffffff12"; e.currentTarget.style.color = "#fff"; e.currentTarget.style.borderColor = "#ffffff33"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#aaa"; e.currentTarget.style.borderColor = "#ffffff18"; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
              <span className="ush-teams-label">Customize Teams</span>
            </button>
            {authLoading ? null : user ? (
              <div style={{ position: "relative" }}>
                <button
                  onClick={() => setShowProfileDropdown((p) => !p)}
                  style={{
                    background: "none", border: "none", cursor: "pointer", padding: 4,
                    display: "flex", alignItems: "center", gap: 8, borderRadius: 8,
                    transition: "all 0.15s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#ffffff12")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                >
                  {profile?.photoURL ? (
                    <img src={profile.photoURL} alt="" style={{ width: 36, height: 36, borderRadius: "50%", border: "2px solid #CC0000", objectFit: "cover" }} referrerPolicy="no-referrer" />
                  ) : (
                    <div style={{
                      width: 36, height: 36, borderRadius: "50%", background: "#CC000033",
                      border: "2px solid #CC0000", display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 15, fontWeight: 700, color: "#CC0000",
                    }}>
                      {(profile?.username || user.email || "?")[0].toUpperCase()}
                    </div>
                  )}
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
                {showProfileDropdown && (
                  <>
                    <div style={{ position: "fixed", inset: 0, zIndex: 199 }} onClick={() => setShowProfileDropdown(false)} />
                    <div style={{
                      position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 200,
                      background: "#1a1a2e", border: "1px solid #2a2a3e", borderRadius: 10,
                      padding: "6px 0", minWidth: 200, boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                    }}>
                      <div style={{ padding: "10px 16px", borderBottom: "1px solid #2a2a3e" }}>
                        <div style={{ color: "#fff", fontSize: 14, fontWeight: 600 }}>{profile?.username || profile?.displayName || user.email?.split("@")[0]}</div>
                        <div style={{ color: "#666", fontSize: 12 }}>{user.email}</div>
                      </div>
                      <button onClick={() => { setShowProfileDropdown(false); setShowProfileSettings(true); }} style={{
                        width: "100%", textAlign: "left", background: "none", border: "none",
                        padding: "10px 16px", color: "#ccc", fontSize: 14, cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 10, transition: "background 0.15s",
                      }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#ffffff08")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                        Settings
                      </button>
                      <button onClick={() => { setShowProfileDropdown(false); logout(); }} style={{
                        width: "100%", textAlign: "left", background: "none", border: "none",
                        padding: "10px 16px", color: "#CC0000", fontSize: 14, cursor: "pointer",
                        display: "flex", alignItems: "center", gap: 10, transition: "background 0.15s",
                      }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = "#ffffff08")}
                        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                        Sign Out
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <button onClick={() => setShowAuthModal(true)} style={{
                background: "none", border: "1px solid #ffffff66", borderRadius: 8,
                padding: "8px 18px", color: "#fff", fontSize: 16, fontWeight: 600,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.15s",
              }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#ffffff18")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      {/* March Madness Banner */}
      <div style={{ padding: "14px 28px 0", maxWidth: 1400, margin: "0 auto" }}>
        {user && hasAnyBracket ? (
          /* Returning user banner — show entries & stats */
          <div className="mm-banner" style={{ cursor: "default" }}>
            <div className="mm-banner-content">
              <span className="mm-banner-emoji">🏀</span>
              <div style={{ textAlign: "left" }}>
                <div className="mm-banner-title">March Madness 2026 — <span style={{ color: "#22c55e" }}>$75 Prize</span></div>
                <div className="mm-banner-sub">Your brackets are live — best score wins $75 cash • Deadline: Thu Mar 19, 12:15 PM ET</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[1, 2].map((num) => {
                const entry = userEntries[num - 1];
                const picks = entry ? Object.keys(entry.picks || {}).length : 0;
                const exists = picks > 0;
                const name = entry?.entryName || (num === 1 ? "Entry 1" : "Entry 2");
                const champion = entry?.picks?.champ;
                return (
                  <button key={num} onClick={() => { setBracketEntry(num); setShowBracket(true); }}
                    className="mm-banner-cta"
                    style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, padding: "8px 16px", minWidth: 150 }}
                  >
                    {exists ? (
                      <>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{name}</span>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        </div>
                        <div style={{ fontSize: 10, color: "#ffffffaa", fontWeight: 400 }}>{picks}/67 picks • Score: 0</div>
                      </>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 16, opacity: 0.6 }}>+</span>
                        <span style={{ fontWeight: 600, fontSize: 12 }}>Add Entry {num}</span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          /* New user / not signed in banner */
          <button
            className="mm-banner"
            onClick={() => {
              if (!user) { setShowAuthModal(true); return; }
              setBracketEntry(1);
              setShowBracket(true);
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.01)"; e.currentTarget.style.boxShadow = "0 6px 30px #CC000066"; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 4px 20px #CC000044"; }}
          >
            <div className="mm-banner-content">
              <span className="mm-banner-emoji">🏀</span>
              <div style={{ textAlign: "left" }}>
                <div className="mm-banner-title">March Madness 2026 — <span style={{ color: "#22c55e" }}>Win $75</span></div>
                <div className="mm-banner-sub">Free to enter — best score wins $75 cash • Deadline: Thu Mar 19, 12:15 PM ET</div>
              </div>
            </div>
            <div className="mm-banner-cta">
              {user ? "Fill Out Bracket" : "Sign In & Play"}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </button>
        )}
      </div>

      {/* Widget Grid */}
      {(() => {
        const displayOrder = !teamsLoaded
          ? ["mammoth", "jazz", "utes-football", "utes-basketball"]
          : order;

        if (teamsLoaded && displayOrder.length === 0) {
          // User hasn't picked teams yet — show prompt
          return (
            <div style={{ textAlign: "center", padding: "80px 20px", color: "#888" }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#444" strokeWidth="1.5" style={{ marginBottom: 16 }}>
                <path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/>
              </svg>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#ccc", marginBottom: 8 }}>Pick your teams to get started</div>
              <button onClick={() => setShowTeamPicker(true)} style={{
                background: "#CC0000", border: "none", borderRadius: 8, padding: "10px 24px",
                color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}>Choose Teams</button>
            </div>
          );
        }

        return (
          <main className="ush-grid" style={{
            padding: "20px 28px 40px", display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(440px, 1fr))",
            gap: 20, maxWidth: 1400, margin: "0 auto",
          }}>
            {displayOrder.map((id, index) => {
              const team = TEAMS_CONFIG.find((t) => t.id === id);
              if (!team) return null;
              return (
                <div key={id} id={`widget-${id}`}
                  style={{ animation: `fadeIn 0.4s ease ${index * 0.08}s both`, position: "relative" }}>
                  {dragOverId === id && draggedId !== id && (
                    <div style={{ position: "absolute", top: -3, left: 0, right: 0, height: 3, background: team.accent, borderRadius: 2, zIndex: 10 }} />
                  )}
                  <TeamWidget team={team} isDragging={draggedId === id}
                    dragHandlers={{
                      onDragStart: (e) => handleDragStart(e, id),
                      onDragOver: (e) => handleDragOver(e, id),
                      onDrop: (e) => handleDrop(e, id),
                      onDragEnd: handleDragEnd,
                    }}
                  />
                </div>
              );
            })}
          </main>
        );
      })()}

      <footer style={{ borderTop: "1px solid #1e1e34", background: "linear-gradient(180deg, #0d0d1a 0%, #08080f 100%)", padding: "32px 28px 20px", color: "#555" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto" }}>
          {/* Top row: Logo + tagline | Live data */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 20, marginBottom: 24 }}>
            {/* Brand */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src="/salt-city-sports-logo.png" alt="Salt City Sports" style={{ width: 30, height: 30, borderRadius: "50%", objectFit: "cover", opacity: 0.85 }} />
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: -0.3 }}>
                  <span style={{ color: "#ccc" }}>Salt City </span><span style={{ color: "#CC0000" }}>Sports</span>
                </div>
                <div style={{ fontSize: 11, color: "#555", marginTop: 2 }}>Your Utah sports hub</div>
              </div>
            </div>
            {/* Live data indicator */}
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#fff" }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#22c55e", display: "inline-block", boxShadow: "0 0 6px #22c55e66" }} />
              Live data &middot; Auto-refreshes every 5 min
            </span>
          </div>
          {/* Divider */}
          <div style={{ height: 1, background: "linear-gradient(90deg, transparent, #1e1e34 30%, #1e1e34 70%, transparent)", marginBottom: 16 }} />
          {/* Bottom row */}
          <div style={{ textAlign: "center", fontSize: 10, color: "#fff" }}>
            <span>&copy; {new Date().getFullYear()} Salt City Sports. Not affiliated with ESPN or any league.</span>
            <div style={{ marginTop: 8, display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => setShowPrivacy(true)} style={{ background: "none", border: "none", color: "#888", fontSize: 10, cursor: "pointer", textDecoration: "underline", padding: 0 }}>Privacy Policy</button>
              <span style={{ color: "#333" }}>|</span>
              <button onClick={() => setShowTosModal(true)} style={{ background: "none", border: "none", color: "#888", fontSize: 10, cursor: "pointer", textDecoration: "underline", padding: 0 }}>Terms of Service</button>
              <span style={{ color: "#333" }}>|</span>
              <span style={{ color: "#888", fontSize: 10 }}>Affiliate Disclosure: We may earn a commission from ticket purchases through our partner links.</span>
            </div>
          </div>
        </div>
      </footer>

      {/* Auth Modal */}
      {showAuthModal && (
        <AuthModal
          onClose={() => setShowAuthModal(false)}
          onLoginGoogle={loginWithGoogle}
          onSignupEmail={signupWithEmail}
          onLoginEmail={loginWithEmail}
        />
      )}

      {/* Profile Settings Modal */}
      {showProfileSettings && user && (
        <ProfileSettingsModal
          user={user}
          profile={profile}
          onClose={() => setShowProfileSettings(false)}
          onProfileUpdated={refreshProfile}
        />
      )}

      {/* Username Prompt for Google users who don't have one yet */}
      {needsUsername && (
        <UsernameSetupModal user={user} onDone={refreshProfile} />
      )}

      {/* Team Picker Modal */}
      {showTeamPicker && (
        <TeamPickerModal
          selectedTeams={selectedTeams || []}
          isFirstTime={!selectedTeams || selectedTeams.length === 0}
          onSave={(teams) => { saveTeamPrefs(teams); setShowTeamPicker(false); }}
          onClose={() => setShowTeamPicker(false)}
        />
      )}

      {/* Privacy Policy Modal */}
      {showPrivacy && (
        <div onClick={() => setShowPrivacy(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 9999,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          backdropFilter: "blur(4px)",
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#12121f", borderRadius: 16, border: "1px solid #2a2a3e",
            maxWidth: 650, width: "100%", maxHeight: "85vh", overflowY: "auto",
            padding: "28px 24px", position: "relative",
          }}>
            <button onClick={() => setShowPrivacy(false)} style={{
              position: "sticky", top: 0, float: "right",
              background: "#2a2a3e", border: "none", borderRadius: 8,
              color: "#aaa", width: 32, height: 32, fontSize: 18, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>&times;</button>

            <h2 style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginBottom: 6, marginTop: 0 }}>Privacy Policy</h2>
            <p style={{ fontSize: 11, color: "#666", marginBottom: 20 }}>Last updated: March 16, 2026</p>

            <div style={{ fontSize: 13, color: "#ccc", lineHeight: 1.75 }}>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>What We Collect.</strong> Salt City Sports ("we", "us") collects the following information when you use our site at saltcitysportsutah.com: your email address and display name when you create an account, profile photos you upload, bracket picks you submit, and chat messages you post. We also collect anonymous usage data through Google Analytics (GA4), including pages visited, session duration, device type, and general geographic location.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>How We Use It.</strong> We use your account information to provide our services — managing your team preferences, bracket entries, leaderboard standings, and chat functionality. Google Analytics data helps us understand how people use the site so we can improve it. We do not sell, rent, or share your personal information with third parties except as required by law.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>Cookies & Tracking.</strong> We use essential cookies for authentication (Firebase Auth) and anonymous analytics cookies (Google Analytics). We do not use advertising cookies or third-party tracking pixels. Google Analytics may set cookies to distinguish unique users and sessions.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>Third-Party Services.</strong> We use the following third-party services: Firebase (Google) for authentication and database, Google Analytics for usage analytics, and affiliate partner links (such as SeatGeek via Impact.com) for ticket purchases. These services have their own privacy policies. When you click an affiliate link, the partner site's privacy policy applies to data collected on their site.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>Affiliate Disclosure.</strong> Some links on this site are affiliate links. If you purchase tickets through our partner links (such as SeatGeek), we may earn a small commission at no additional cost to you. This helps support the site.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>Data Storage & Security.</strong> Your data is stored securely using Google Firebase (Firestore). We use industry-standard security measures to protect your information. However, no method of electronic storage is 100% secure, and we cannot guarantee absolute security.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>Your Rights.</strong> You can delete your account and associated data at any time by contacting us. You can clear your browser cookies to remove analytics tracking. California residents (CCPA) and EU residents (GDPR) may have additional rights regarding their personal data — contact us to exercise these rights.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>Children's Privacy.</strong> Salt City Sports is not intended for children under 13. We do not knowingly collect personal information from children under 13. If you believe we have collected such information, please contact us immediately.
              </p>
              <p style={{ marginBottom: 14 }}>
                <strong style={{ color: "#fff" }}>Changes.</strong> We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated "Last updated" date.
              </p>
              <p style={{ marginBottom: 0, color: "#888" }}>
                <strong style={{ color: "#aaa" }}>Contact.</strong> For questions about this Privacy Policy or to request data deletion, email us at saltcitysportsutah@gmail.com.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Terms of Service Modal */}
      {showTosModal && (
        <div onClick={() => setShowTosModal(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", zIndex: 9999,
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
          backdropFilter: "blur(4px)",
        }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            background: "#12121f", borderRadius: 16, border: "1px solid #2a2a3e",
            maxWidth: 650, width: "100%", maxHeight: "85vh", overflowY: "auto",
            padding: "28px 24px", position: "relative",
          }}>
            <button onClick={() => setShowTosModal(false)} style={{
              position: "sticky", top: 0, float: "right",
              background: "#2a2a3e", border: "none", borderRadius: 8,
              color: "#aaa", width: 32, height: 32, fontSize: 18, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>&times;</button>

            <h2 style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginBottom: 6, marginTop: 0 }}>Terms of Service</h2>
            <p style={{ fontSize: 11, color: "#666", marginBottom: 20 }}>Last updated: March 16, 2026</p>

            <div style={{ fontSize: 13, color: "#ccc", lineHeight: 1.75 }}>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>1. Acceptance.</strong> By creating an account on Salt City Sports (saltcitysportsutah.com), you agree to these Terms of Service. If you do not agree, do not create an account or use the site.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>2. Eligibility.</strong> You must be at least 18 years of age to create an account. By registering, you represent that you are 18 or older and that all information you provide is truthful and accurate.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>3. Accounts.</strong> You are responsible for maintaining the security of your account. You agree not to share your login credentials. We reserve the right to suspend or terminate accounts that violate these Terms.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>4. User Content.</strong> You are responsible for all content you post, including chat messages, display names, and profile pictures. You agree not to post content that is abusive, threatening, defamatory, obscene, or illegal. We reserve the right to remove content and suspend accounts that violate this policy.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>5. Sports Data.</strong> Scores, schedules, standings, statistics, and news displayed on this site are sourced from third-party providers and are for entertainment and informational purposes only. We do not guarantee the accuracy, completeness, or timeliness of this data. Do not rely on it for betting, financial, or other decisions.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>6. Contests.</strong> Participation in contests (such as bracket challenges) is subject to the Official Contest Rules posted on the relevant page. Contests are skill-based, free to enter, and not gambling.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>7. Intellectual Property.</strong> Salt City Sports is an independent fan site. Team names, logos, and league marks are the property of their respective owners. "March Madness" is a registered trademark of the NCAA. We are not affiliated with, endorsed by, or sponsored by any professional or collegiate sports league, team, or ESPN.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>8. Affiliate Links.</strong> Some links on this site (such as ticket purchase links) are affiliate links. We may earn a small commission from purchases made through these links at no additional cost to you.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>9. Limitation of Liability.</strong> Salt City Sports is provided "as is" without warranties of any kind. We are not liable for any damages arising from your use of the site, including data loss, service interruptions, or inaccurate sports data.</p>
              <p style={{ marginBottom: 14 }}><strong style={{ color: "#fff" }}>10. Changes.</strong> We may update these Terms at any time. Continued use of the site after changes constitutes acceptance. Material changes will be communicated via a notice on the site.</p>
              <p style={{ marginBottom: 0, color: "#888" }}><strong style={{ color: "#aaa" }}>11. Governing Law.</strong> These Terms are governed by the laws of the State of Utah. For questions, contact saltcitysportsutah@gmail.com.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
