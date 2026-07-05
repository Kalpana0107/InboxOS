import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { AuthLayout } from './AuthLayout';
import { auth, googleProvider, isFirebaseConfigured } from '../firebase';
import { signInWithPopup } from 'firebase/auth';
import {
  Sparkles,
  Mail,
  Lock,
  AlertCircle,
  Eye,
  EyeOff,
  Loader2,
  ArrowRight,
} from 'lucide-react';

const GoogleIcon = () => (
  <svg
    className="w-[18px] h-[18px]"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      fill="#4285F4"
    />
    <path
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      fill="#34A853"
    />
    <path
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
      fill="#FBBC05"
    />
    <path
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      fill="#EA4335"
    />
  </svg>
);

export const LoginForm: React.FC = () => {
  const { login, loginWithFirebase, error: authError, clearError } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isCapsLockOn, setIsCapsLockOn] = useState(false);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const caps = e.getModifierState('CapsLock');
    setIsCapsLockOn(caps);
  };

  const validate = () => {
    let isValid = true;
    if (!email) {
      setEmailError('Email is required');
      isValid = false;
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      setEmailError('Please enter a valid email address');
      isValid = false;
    } else {
      setEmailError(null);
    }

    if (!password) {
      setPasswordError('Password is required');
      isValid = false;
    } else if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      isValid = false;
    } else {
      setPasswordError(null);
    }

    return isValid;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    if (!validate()) return;
    setIsLoading(true);
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch (err) {
      console.error('Login error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthLayout>
      <div className="w-full space-y-6 text-left">
        {/* Welcome */}
        <div className="space-y-1.5 pb-2">
          <h3 className="text-[36px] font-bold text-[#1D1D1D] tracking-tight leading-none flex items-center gap-2.5">
            Welcome Back <Sparkles size={24} className="text-[#5F6B38]" />
          </h3>
          <p className="text-[16px] text-[#6B7280]">
            Sign in to your AI Inbox Operating System.
          </p>
        </div>

        {/* Google Authentication (Redesigned White Button) */}
        <button
          type="button"
          onClick={async () => {
            if (!isFirebaseConfigured) {
              setIsLoading(true);
              setTimeout(() => {
                setIsLoading(false);
                login('demo@inboxos.dev', 'password123').then(() =>
                  navigate('/dashboard')
                );
              }, 1000);
              return;
            }
            setIsLoading(true);
            try {
              const result = await signInWithPopup(auth, googleProvider);
              const idToken = await result.user.getIdToken();
              await loginWithFirebase(idToken);
              navigate('/dashboard');
            } catch (err: any) {
              console.error('Google sign-in error:', err);
            } finally {
              setIsLoading(false);
            }
          }}
          className="w-full h-[54px] flex items-center justify-center gap-3 bg-white border border-[#EAE5DA] rounded-[16px] text-[#1D1D1D] text-[15px] font-semibold transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.98] hover:bg-[#FAF7F2]"
        >
          <GoogleIcon />
          <span>Continue with Google</span>
        </button>

        {/* Divider */}
        <div className="flex items-center gap-4 py-2">
          <div className="flex-grow border-t border-[#EAE5DA]" />
          <span className="text-[11px] font-bold uppercase tracking-widest text-[#9CA3AF]">
            OR
          </span>
          <div className="flex-grow border-t border-[#EAE5DA]" />
        </div>

        {/* Auth Error Alert */}
        {authError && (
          <div className="flex items-center gap-3 p-4 bg-[#FFF0F0] border border-[#FCA5A5] rounded-[14px] text-[#EF4444] text-xs">
            <AlertCircle size={16} className="shrink-0 text-[#EF4444]" />
            <p className="leading-snug font-medium">{authError}</p>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Email */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-[#374151] tracking-wide block">
              Email Address
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9CA3AF]">
                <Mail size={16} strokeWidth={1.5} />
              </span>
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
                disabled={isLoading}
                className={`w-full h-[54px] pl-11 pr-4 text-[15px] bg-[#FCFCFE] border rounded-[14px] text-[#1D1D1D] placeholder-[#9CA3AF] outline-none transition-all duration-200 ${
                  emailError
                    ? 'border-[#EF4444] focus:border-[#EF4444] focus:ring-4 focus:ring-[#EF4444]/10'
                    : 'border-[#EAE5DA] focus:border-[#5F6B38] focus:ring-4 focus:ring-[#5F6B38]/10'
                }`}
              />
            </div>
            {emailError && (
              <p className="text-[11px] flex items-center gap-1.5 mt-1 font-semibold text-[#EF4444] pl-1">
                <AlertCircle size={11} />
                <span>{emailError}</span>
              </p>
            )}
          </div>

          {/* Password */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label className="text-xs font-semibold text-[#374151] tracking-wide block">
                Password
              </label>
              <a
                href="#"
                className="text-xs font-semibold text-[#5F6B38] hover:underline"
              >
                Forgot Password?
              </a>
            </div>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9CA3AF]">
                <Lock size={16} strokeWidth={1.5} />
              </span>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onKeyDown={handleKeyDown}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError(null);
                }}
                disabled={isLoading}
                className={`w-full h-[54px] pl-11 pr-12 text-[15px] bg-[#FCFCFE] border rounded-[14px] text-[#1D1D1D] placeholder-[#9CA3AF] outline-none transition-all duration-200 ${
                  passwordError
                    ? 'border-[#EF4444] focus:border-[#EF4444] focus:ring-4 focus:ring-[#EF4444]/10'
                    : 'border-[#EAE5DA] focus:border-[#5F6B38] focus:ring-4 focus:ring-[#5F6B38]/10'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-[#6B7280] hover:text-[#1D1D1D] transition-colors"
              >
                {showPassword ? <EyeOff size={16} strokeWidth={1.5} /> : <Eye size={16} strokeWidth={1.5} />}
              </button>
            </div>
            {isCapsLockOn && (
              <p className="text-[10px] flex items-center gap-1.5 mt-1 font-semibold text-[#F59E0B] pl-1">
                <AlertCircle size={10} />
                <span>Caps Lock is On</span>
              </p>
            )}
            {passwordError && (
              <p className="text-[11px] flex items-center gap-1.5 mt-1 font-semibold text-[#EF4444] pl-1">
                <AlertCircle size={11} />
                <span>{passwordError}</span>
              </p>
            )}
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full h-[54px] flex items-center justify-center gap-2 bg-[#5F6B38] hover:bg-[#4F5A2F] text-white text-[15px] font-semibold rounded-[16px] transition-all duration-200 hover:-translate-y-[2px] hover:shadow-[0_8px_25px_rgba(95,107,56,0.25)] active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none mt-4"
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin text-white" />
                <span>Authenticating...</span>
              </>
            ) : (
              <>
                <span>Continue</span>
                <ArrowRight size={15} strokeWidth={2} />
              </>
            )}
          </button>
        </form>

        {/* Footer Links */}
        <div className="text-center pt-5 border-t border-[#EAE5DA] mt-3">
          <p className="text-xs text-[#6B7280]">
            Join thousands of users running email as an operating system.
          </p>
          <Link
            to="/register"
            onClick={clearError}
            className="text-xs font-semibold text-[#5F6B38] hover:underline mt-2 block"
          >
            Create an Account
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
};
