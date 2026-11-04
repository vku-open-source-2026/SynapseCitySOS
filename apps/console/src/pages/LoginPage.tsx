// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from 'react';
import { useNavigate, Link } from '@tanstack/react-router';
import { isAxiosError } from 'axios';
import { useAuthStore } from '../stores/authStore';
import { authApi } from '../api/auth';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';

export function LoginPage() {
  const navigate = useNavigate();
  const { login } = useAuthStore();
  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await authApi.login(formData);
      login(response.access_token, response.refresh_token, response.user);
      navigate({ to: '/admin' });
    } catch (err: unknown) {
      if (isAxiosError<{ detail?: string; error?: string }>(err)) {
        if (err.response?.data?.error === 'demo_auth_disabled') {
          setError(
            'Đăng nhập demo đang tắt. Quản trị viên cần bật ALLOW_DEMO_AUTH cho môi trường demo hoặc cấu hình Tier-1 IAM.'
          );
        } else {
          setError(err.response?.data?.detail || 'Đăng nhập thất bại. Vui lòng kiểm tra thông tin.');
        }
      } else {
        setError('Đăng nhập thất bại. Vui lòng kiểm tra thông tin.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Đăng nhập tài khoản</CardTitle>
          <CardDescription>Nhập thông tin để truy cập hệ thống</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">
                {error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="username">Tên đăng nhập</Label>
              <Input
                id="username"
                type="text"
                required
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                placeholder="Nhập tên đăng nhập"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Mật khẩu</Label>
              <Input
                id="password"
                type="password"
                required
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="Nhập mật khẩu"
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Đang đăng nhập...' : 'Đăng nhập'}
            </Button>

            <p className="text-xs text-slate-500">
              Phiên demo chỉ mở khi quản trị viên bật <code>ALLOW_DEMO_AUTH</code>. Danh tính sản xuất
              do Tier-1 IAM cấp qua Tier-2; sinh trắc học không được hỗ trợ cục bộ.
            </p>

            <div className="text-center text-sm">
              <span className="text-gray-600">Chưa có tài khoản? </span>
              <Link to="/register" className="text-blue-600 hover:text-blue-500">
                Đăng ký ngay
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
