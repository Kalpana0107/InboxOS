import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, AlertCircle, Eye, EyeOff, Loader2, UserCheck } from 'lucide-react';

export const RegisterForm: React.FC = () => {
  const { register, error: authError, clearError } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  // Local validation errors
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<string | null>(null);

  const validate = () => {
    let isValid = true;
    
    // Email check
    if (!email) {
      setEmailError('Email is required');
      isValid = false;
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      setEmailError('Please enter a valid email address');
      isValid = false;
    } else {
      setEmailError(null);
    }

    // Password check
    if (!password) {
      setPasswordError('Password is required');
      isValid = false;
    } else if (password.length < 6) {
      setPasswordError('Password must be at least 6 characters');
      isValid = false;
    } else {
      setPasswordError(null);
    }

    // Confirm password check
    if (!confirmPassword) {
      setConfirmPasswordError('Please confirm your password');
      isValid = false;
    } else if (password !== confirmPassword) {
      setConfirmPasswordError('Passwords do not match');
      isValid = false;
    } else {
      setConfirmPasswordError(null);
    }

    return isValid;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    
    if (!validate()) return;

    setIsLoading(true);
    try {
      await register(email, password);
      navigate('/');
    } catch (err) {
      console.error('Registration error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-base flex flex-col justify-center items-center px-4 relative overflow-hidden select-none">
      
      {/* Background ambient lighting effects */}
      <div className="absolute top-[-10%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-indigo-500/10 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] left-[-10%] w-[50vw] h-[50vw] rounded-full bg-purple-500/10 blur-[120px] pointer-events-none" />

      {/* Main glassmorphic register container */}
      <div className="w-full max-w-[420px] glass rounded-3xl p-8 relative z-10 border border-white/5 shadow-2xl backdrop-blur-2xl">
        
        {/* Header Logo */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-tr from-indigo-500 to-purple-600 glow-accent mb-4">
            <UserCheck size={24} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            Create Account
          </h1>
          <p className="text-xs text-gray-400 mt-1.5">
            Get started with your AI email operating system.
          </p>
        </div>

        {/* Global authentication alerts */}
        {authError && (
          <div className="flex items-center gap-3 p-4 mb-6 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs animate-shake">
            <AlertCircle size={16} className="shrink-0" />
            <p className="leading-snug">{authError}</p>
          </div>
        )}

        {/* Register Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* Email Input */}
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
              Email Address
            </label>
            <div className="relative">
              <span className="absolute left-4 top-3 text-gray-400">
                <Mail size={16} />
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
                className={`w-full bg-white/5 border rounded-2xl pl-11 pr-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 transition-all duration-200 focus:outline-none focus:ring-2 ${
                  emailError 
                    ? 'border-rose-500/50 focus:ring-rose-500/20' 
                    : 'border-white/5 hover:border-white/10 focus:border-indigo-500/40 focus:ring-indigo-500/20'
                }`}
              />
            </div>
            {emailError && (
              <p className="text-[10px] text-rose-400 flex items-center gap-1.5 mt-1 font-medium pl-1">
                <AlertCircle size={10} />
                <span>{emailError}</span>
              </p>
            )}
          </div>

          {/* Password Input */}
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
              Password
            </label>
            <div className="relative">
              <span className="absolute left-4 top-3 text-gray-400">
                <Lock size={16} />
              </span>
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Minimum 6 characters"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (passwordError) setPasswordError(null);
                }}
                disabled={isLoading}
                className={`w-full bg-white/5 border rounded-2xl pl-11 pr-12 py-2.5 text-sm text-gray-100 placeholder-gray-500 transition-all duration-200 focus:outline-none focus:ring-2 ${
                  passwordError 
                    ? 'border-rose-500/50 focus:ring-rose-500/20' 
                    : 'border-white/5 hover:border-white/10 focus:border-indigo-500/40 focus:ring-indigo-500/20'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                className="absolute right-4 top-3 text-gray-400 hover:text-gray-200 transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {passwordError && (
              <p className="text-[10px] text-rose-400 flex items-center gap-1.5 mt-1 font-medium pl-1">
                <AlertCircle size={10} />
                <span>{passwordError}</span>
              </p>
            )}
          </div>

          {/* Confirm Password Input */}
          <div className="space-y-1">
            <label className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider block">
              Confirm Password
            </label>
            <div className="relative">
              <span className="absolute left-4 top-3 text-gray-400">
                <Lock size={16} />
              </span>
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                placeholder="Confirm password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (confirmPasswordError) setConfirmPasswordError(null);
                }}
                disabled={isLoading}
                className={`w-full bg-white/5 border rounded-2xl pl-11 pr-12 py-2.5 text-sm text-gray-100 placeholder-gray-500 transition-all duration-200 focus:outline-none focus:ring-2 ${
                  confirmPasswordError 
                    ? 'border-rose-500/50 focus:ring-rose-500/20' 
                    : 'border-white/5 hover:border-white/10 focus:border-indigo-500/40 focus:ring-indigo-500/20'
                }`}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                tabIndex={-1}
                className="absolute right-4 top-3 text-gray-400 hover:text-gray-200 transition-colors"
              >
                {showConfirmPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            {confirmPasswordError && (
              <p className="text-[10px] text-rose-400 flex items-center gap-1.5 mt-1 font-medium pl-1">
                <AlertCircle size={10} />
                <span>{confirmPasswordError}</span>
              </p>
            )}
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm transition-all duration-200 glow-accent-hover active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none mt-4"
          >
            {isLoading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Creating Account...</span>
              </>
            ) : (
              <span>Create Account</span>
            )}
          </button>

        </form>

        {/* Footer Toggle */}
        <div className="text-center mt-6 text-xs text-gray-400">
          <span>Already have an account? </span>
          <Link 
            to="/login" 
            onClick={clearError}
            className="font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            Sign In
          </Link>
        </div>

      </div>
    </div>
  );
};
