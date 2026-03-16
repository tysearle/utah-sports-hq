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
    conference: "Big 12",
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
    conference: "Big 12",
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
    conference: "Big 12",
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
    conference: "Big 12",
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
    conference: "Mountain West",
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
    conference: "Mountain West",
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
            if (statusName.includes("IN_PROGRESS")) {
              const teamComp = comp?.competitors?.find(
                (c) => String(c.team?.id) === String(team.teamId) || c.team?.abbreviation?.toLowerCase() === team.teamId?.toLowerCase()
              );
              if (teamComp) {
                const opp = comp.competitors.find((c) => c !== teamComp);
                liveScoreMap.us = parseInt(teamComp.score || "0");
                liveScoreMap.them = parseInt(opp?.score || "0");
                liveScoreMap.detail = comp.status?.type?.shortDetail || "";
                liveScoreMap.oppName = opp?.team?.displayName || "";
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
              comp?.geoBroadcasts?.[0]?.media?.shortName ||
              "--";
            const statusName = comp?.status?.type?.name || ev.status?.type?.name || "";
            const isFinal = statusName.includes("FINAL") || statusName === "post";
            const isLive = statusName.includes("IN_PROGRESS") || statusName === "STATUS_IN_PROGRESS" || statusName === "in";
            const statusDetail = comp?.status?.type?.shortDetail || comp?.status?.shortDetail || ev.status?.type?.shortDetail || "";

            let result = "";
            let liveScore = null;
            if ((isFinal || isLive) && us && them) {
              const usS = parseInt(us.score?.displayValue || us.score || "0");
              const thS = parseInt(them.score?.displayValue || them.score || "0");
              if (isFinal) {
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
      <div style={{ display: "flex", gap: 2, marginBottom: 12, borderBottom: `1px solid ${accent}33` }}>
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            onClick={() => setActive(i)}
            style={{
              background: active === i ? accent + "22" : "transparent",
              color: active === i ? accent : "#aaa",
              border: "none",
              borderBottom: active === i ? `2px solid ${accent}` : "2px solid transparent",
              padding: "8px 14px", fontSize: 12,
              fontWeight: active === i ? 700 : 500,
              cursor: "pointer", transition: "all 0.2s",
              letterSpacing: 0.3, textTransform: "uppercase",
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
  // Season year: 2025-26 seasons = 2026 for most sports; MLB uses calendar year
  const season = isBaseball ? 2026 : 2026;

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
                const gp = parseFloat(find("GP", "general")?.displayValue || "0");
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
                  const avg = parseFloat(find("AVG")?.displayValue || find("BA")?.displayValue || "0");
                  const hr = parseFloat(find("HR")?.displayValue || "0");
                  const rbi = parseFloat(find("RBI")?.displayValue || "0");
                  const ops = parseFloat(find("OPS")?.displayValue || "0");
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
          style={{ width: 44, height: 44, borderRadius: 8, background: team.logoBgLight ? "#fff" : "#222", objectFit: "contain", padding: 3 }}
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
        <a href={team.espnUrl} target="_blank" rel="noopener noreferrer" style={{
          background: team.accent + "22", border: `1px solid ${team.accent}44`,
          borderRadius: 6, padding: "6px 10px", color: team.accent,
          fontSize: 10, fontWeight: 700, textDecoration: "none", textTransform: "uppercase",
        }}>ESPN</a>
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
  { key: "all", label: "All" },
  { key: "MLB", label: "MLB" },
  { key: "NBA", label: "NBA" },
  { key: "NCAAF", label: "NCAA FB" },
  { key: "NCAAM", label: "NCAA MB" },
  { key: "NHL", label: "NHL" },
];

function TeamPickerModal({ selectedTeams, onSave, onClose, isFirstTime }) {
  const [picked, setPicked] = useState(selectedTeams || []);
  const [activeTab, setActiveTab] = useState("all");

  const toggle = (id) => {
    setPicked((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_TEAMS) return prev; // enforce cap
      return [...prev, id];
    });
  };

  const canSave = picked.length >= 1 && picked.length <= MAX_TEAMS;
  const filteredTeams = activeTab === "all"
    ? TEAMS_CONFIG
    : TEAMS_CONFIG.filter((t) => t.leagueTag === activeTab);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 9999,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }} onClick={(e) => { if (!isFirstTime && e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#12121f", border: "1px solid #2a2a3e", borderRadius: 16,
        padding: "28px 24px", maxWidth: 520, width: "100%", maxHeight: "90vh", overflowY: "auto",
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
        <p style={{ color: "#888", fontSize: 13, margin: "0 0 20px" }}>
          Select up to {MAX_TEAMS} teams to follow. {picked.length}/{MAX_TEAMS} selected.
        </p>

        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {PICKER_TABS.map((tab) => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
              padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              fontSize: 12, fontWeight: 600, transition: "all 0.2s",
              background: activeTab === tab.key ? "#fff" : "#2a2a3e",
              color: activeTab === tab.key ? "#12121f" : "#999",
            }}>{tab.label}</button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {filteredTeams.map((team) => {
            const isSelected = picked.includes(team.id);
            const isDisabled = !isSelected && picked.length >= MAX_TEAMS;
            return (
              <div key={team.id} onClick={() => !isDisabled && toggle(team.id)} style={{
                display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                borderRadius: 10, cursor: isDisabled ? "not-allowed" : "pointer",
                border: isSelected ? `2px solid ${team.accent}` : "2px solid #2a2a3e",
                background: isSelected ? team.accent + "15" : "#1a1a2e",
                opacity: isDisabled ? 0.4 : 1, transition: "all 0.2s",
              }}>
                <img src={team.logo} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: "contain", background: "#222", padding: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ color: isSelected ? team.accent : "#ccc", fontSize: 13, fontWeight: 600 }}>{team.shortName}</div>
                  <div style={{ color: "#666", fontSize: 10 }}>{team.league} • {team.venue}</div>
                </div>
                <div style={{
                  width: 22, height: 22, borderRadius: 6,
                  border: isSelected ? `2px solid ${team.accent}` : "2px solid #444",
                  background: isSelected ? team.accent : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                }}>
                  {isSelected && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 20, justifyContent: "flex-end" }}>
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
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(new Date());

  // If Google user signs in without a username, they need to set one
  const needsUsername = user && profile && !profile.username;

  // Load team preferences from Firebase on login
  useEffect(() => {
    if (!user) {
      setSelectedTeams(null);
      setOrder([]);
      setTeamsLoaded(false);
      return;
    }
    (async () => {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        const data = snap.exists() ? snap.data() : {};
        if (data.selectedTeams && data.selectedTeams.length > 0) {
          // Validate that saved teams still exist in config
          const valid = data.selectedTeams.filter(id => TEAMS_CONFIG.find(t => t.id === id));
          setSelectedTeams(valid);
          setOrder(valid);
        } else {
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

  // Save team preferences to Firebase
  const saveTeamPrefs = async (teams) => {
    if (!user) return;
    setSelectedTeams(teams);
    setOrder(teams);
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
      // Persist reorder to Firebase
      if (user) {
        setDoc(doc(db, "users", user.uid), { selectedTeams: n }, { merge: true }).catch(() => {});
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
    return <BracketChallenge user={user} onBack={() => { setShowBracket(false); setBracketInitialTab("bracket"); }} initialEntry={bracketEntry} initialTab={bracketInitialTab} />;
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
            <div>
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
        .ush-logo { width: 48px; height: 48px; }
        .ush-title { font-size: 22px; }
        @media (max-width: 768px) {
          .ush-header { flex-wrap: wrap !important; gap: 8px !important; padding: 10px 12px !important; align-items: center !important; justify-content: space-between !important; }
          .ush-header-left { order: 1 !important; }
          .ush-header-right { order: 2 !important; flex-direction: row !important; gap: 6px !important; align-items: center !important; }
          .ush-header-nav { order: 3 !important; width: 100% !important; gap: 6px !important; justify-content: center !important; margin-left: 0 !important; }
          .ush-leaderboard-btn, .ush-chat-btn { padding: 5px 10px !important; font-size: 11px !important; display: inline-flex !important; flex: 1 !important; justify-content: center !important; }
          .ush-auth-section { gap: 6px !important; flex-wrap: nowrap !important; }
          .ush-teams-label { display: none !important; }
          .ush-profile-info { display: none !important; }
          .ush-admin-btn { padding: 4px 6px !important; font-size: 10px !important; }
          .ush-header-left { gap: 8px !important; }
          .ush-logo { width: 32px !important; height: 32px !important; }
          .ush-title { font-size: 16px !important; }
          .ush-subtitle { display: none !important; }
          .ush-grid { padding: 12px 10px 30px !important; grid-template-columns: 1fr !important; gap: 14px !important; }
        }
      `}</style>

      {/* Header */}
      <header className="ush-header" style={{
        background: "linear-gradient(135deg, #12121f 0%, #1a1a30 100%)",
        borderBottom: "1px solid #2a2a3e", padding: "16px 28px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(12px)",
      }}>
        <div className="ush-header-left" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <img className="ush-logo" src="/salt-city-sports-logo.png" alt="Salt City Sports" style={{ borderRadius: "50%", objectFit: "cover" }} />
          <div>
            <h1 className="ush-title" style={{ margin: 0, fontWeight: 800, letterSpacing: -0.5 }}>
              Salt City <span style={{ color: "#CC0000" }}>Sports</span>
            </h1>
            <p className="ush-subtitle" style={{ margin: 0, fontSize: 11, color: "#666", letterSpacing: 0.5 }}>
              YOUR UTAH SPORTS HUB | LIVE DATA | AUTO-REFRESHES
            </p>
          </div>
        </div>
        {/* Nav buttons - next to auth on desktop, own row on mobile */}
        <div className="ush-header-nav" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          {user && (
            <button onClick={() => { setBracketEntry(1); setBracketInitialTab("lb"); setShowBracket(true); }}
              className="ush-leaderboard-btn"
              style={{
                background: "#FFD70015", border: "1px solid #FFD70044", borderRadius: 8,
                padding: "8px 14px", color: "#FFD700", fontSize: 12, fontWeight: 600,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#FFD70033")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#FFD70015")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20V10"/><path d="M18 20V4"/><path d="M6 20v-4"/></svg>
              Live Leaderboard
            </button>
          )}
          {user && (
            <button onClick={() => { setBracketEntry(1); setBracketInitialTab("chat"); setShowBracket(true); }}
              className="ush-chat-btn"
              style={{
                background: "#4CAF5015", border: "1px solid #4CAF5044", borderRadius: 8,
                padding: "8px 14px", color: "#4CAF50", fontSize: 12, fontWeight: 600,
                cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s",
                whiteSpace: "nowrap",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#4CAF5033")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#4CAF5015")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
              View Chat
            </button>
          )}
        </div>
        {/* Auth section */}
        <div className="ush-header-right" style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {authLoading ? null : user ? (
            <div className="ush-auth-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button onClick={() => setShowTeamPicker(true)}
                title="Customize teams"
                style={{
                  background: "#ffffff10", border: "1px solid #ffffff22", borderRadius: 8,
                  padding: "6px 10px", color: "#aaa", fontSize: 11, fontWeight: 600,
                  cursor: "pointer", display: "flex", alignItems: "center", gap: 4, transition: "all 0.2s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#ffffff22")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#ffffff10")}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                <span className="ush-teams-label">Teams</span>
              </button>
              {isAdmin && (
                <button onClick={() => { setShowAdmin(true); loadAdminUsers(); }}
                  className="ush-admin-btn"
                  style={{
                    background: "#4A90D915", border: "1px solid #4A90D944", borderRadius: 8,
                    padding: "6px 10px", color: "#4A90D9", fontSize: 11, fontWeight: 600,
                    cursor: "pointer", display: "flex", alignItems: "center", gap: 4, transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#4A90D933")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "#4A90D915")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197"/></svg>
                  Admin
                </button>
              )}
              <div onClick={() => setShowProfileSettings(true)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }} title="Profile settings">
                {profile?.photoURL ? (
                  <img src={profile.photoURL} alt="" style={{ width: 30, height: 30, borderRadius: "50%", border: "2px solid #CC0000", objectFit: "cover" }} referrerPolicy="no-referrer" />
                ) : (
                  <div style={{
                    width: 30, height: 30, borderRadius: "50%", background: "#CC000033",
                    border: "2px solid #CC0000", display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 13, fontWeight: 700, color: "#CC0000",
                  }}>
                    {(profile?.username || user.email || "?")[0].toUpperCase()}
                  </div>
                )}
                <div className="ush-profile-info">
                  <div className="ush-username" style={{ fontSize: 11, color: "#ccc", fontWeight: 600, maxWidth: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{profile?.username || profile?.displayName || user.email?.split("@")[0]}</div>
                  <div style={{ fontSize: 9, color: "#666" }}>Settings</div>
                </div>
              </div>
              <button onClick={logout} style={{ background: "none", border: "none", color: "#888", fontSize: 9, cursor: "pointer", padding: 0, textDecoration: "underline", alignSelf: "flex-end" }}>Sign out</button>
            </div>
          ) : (
            <button onClick={() => setShowAuthModal(true)} style={{
              background: "#1a1a2e", border: "1px solid #CC000066", borderRadius: 8,
              padding: "8px 14px", color: "#CC0000", fontSize: 12, fontWeight: 600,
              cursor: "pointer", display: "flex", alignItems: "center", gap: 6, transition: "all 0.2s",
            }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#CC000022")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#1a1a2e")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
              Sign in
            </button>
          )}
        </div>
      </header>

      {/* March Madness Banner */}
      <div style={{ padding: "14px 28px 0" }}>
        {user && hasAnyBracket ? (
          /* Returning user banner — show entries & stats */
          <div className="mm-banner" style={{ cursor: "default" }}>
            <div className="mm-banner-content">
              <span className="mm-banner-emoji">🏀</span>
              <div style={{ textAlign: "left" }}>
                <div className="mm-banner-title">March Madness 2026</div>
                <div className="mm-banner-sub">Your brackets are live — edit or add a second entry</div>
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
                <div className="mm-banner-title">March Madness 2026 Bracket Challenge</div>
                <div className="mm-banner-sub">Make your picks, compete on the leaderboard, and prove you know college hoops</div>
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
        // For non-logged-in users, show default 4 teams
        const displayOrder = (!user || !teamsLoaded)
          ? ["mammoth", "jazz", "utes-football", "utes-basketball"]
          : order;

        if (user && teamsLoaded && displayOrder.length === 0) {
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

      <footer style={{ textAlign: "center", padding: "20px 28px", borderTop: "1px solid #1a1a2e", color: "#444", fontSize: 11 }}>
        <div style={{ marginBottom: 8 }}>Salt City Sports | Live data from ESPN API via serverless proxy | Auto-refreshes every 5 minutes</div>
        <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
          <a href="https://x.com/saltcitysportut" target="_blank" rel="noopener noreferrer" style={{ color: "#666", textDecoration: "none", display: "flex", alignItems: "center", gap: 4 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.602l-5.165-6.748L2.881 21.75H-1.265l7.732-8.835L-1.993 2.25h6.736l4.793 6.341 5.982-6.341zM16.905 19.5h1.829L5.327 4.132H3.457l13.448 15.368z"/></svg>
            X
          </a>
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
      {showTeamPicker && user && (
        <TeamPickerModal
          selectedTeams={selectedTeams || []}
          isFirstTime={!selectedTeams || selectedTeams.length === 0}
          onSave={(teams) => { saveTeamPrefs(teams); setShowTeamPicker(false); }}
          onClose={() => setShowTeamPicker(false)}
        />
      )}
    </div>
  );
}
