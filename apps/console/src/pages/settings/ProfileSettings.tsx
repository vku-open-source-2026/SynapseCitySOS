// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { authApi } from "@/api/auth";
import {
    Form,
    FormField,
    FormLabel,
    FormError,
} from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { useAuthStore } from "../../stores/authStore";

/**
 * Auth-shell profile settings.
 *
 * The emergency console only manages the signed-in session: reading identity
 * from the auth store, changing the password through /v1/auth and managing the
 * shell session. Biometric replay is disabled; production WebAuthn belongs to Tier-1 IAM.
 */
const ProfileSettings: React.FC = () => {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const { user, logout } = useAuthStore();
    const [passwordData, setPasswordData] = useState({
        current_password: "",
        new_password: "",
        confirm_password: "",
    });
    const [errors, setErrors] = useState<Record<string, string>>({});

    const getApiErrorDetail = (error: unknown): string | undefined => {
        return (error as { response?: { data?: { detail?: string } } })
            .response?.data?.detail;
    };

    const changePasswordMutation = useMutation({
        mutationFn: ({
            current,
            new: newPass,
        }: {
            current: string;
            new: string;
        }) =>
            authApi.changePassword({
                current_password: current,
                new_password: newPass,
            }),
        onSuccess: () => {
            setPasswordData({
                current_password: "",
                new_password: "",
                confirm_password: "",
            });
            setErrors({});
        },
        onError: (error: unknown) => {
            const detail = getApiErrorDetail(error);
            if (detail) {
                setErrors({ password: detail });
            }
        },
    });

    const handlePasswordSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        setErrors({});

        if (!passwordData.current_password) {
            setErrors({ password: "Mật khẩu hiện tại là bắt buộc" });
            return;
        }
        if (
            !passwordData.new_password ||
            passwordData.new_password.length < 6
        ) {
            setErrors({
                password: "Mật khẩu mới phải có ít nhất 6 ký tự",
            });
            return;
        }
        if (passwordData.new_password !== passwordData.confirm_password) {
            setErrors({ password: "Mật khẩu không khớp" });
            return;
        }

        changePasswordMutation.mutate({
            current: passwordData.current_password,
            new: passwordData.new_password,
        });
    };

    const handleLogout = () => {
        logout();
        queryClient.clear();
        navigate({ to: "/" });
    };

    return (
        <div className="p-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-slate-900">
                    Cài đặt tài khoản
                </h1>
                <p className="text-slate-500 mt-1">
                    Phiên đăng nhập và bảo mật của trung tâm điều hành SOS
                </p>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 p-6">
                <h2 className="text-lg font-semibold mb-4">
                    Thông tin phiên đăng nhập
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <FormField>
                        <FormLabel>Tên đăng nhập</FormLabel>
                        <Input
                            value={user?.username || ""}
                            disabled
                            className="bg-slate-50"
                        />
                    </FormField>

                    <FormField>
                        <FormLabel>Email</FormLabel>
                        <Input
                            type="email"
                            value={user?.email || ""}
                            disabled
                            className="bg-slate-50"
                        />
                    </FormField>

                    <FormField>
                        <FormLabel>Họ và tên</FormLabel>
                        <Input
                            value={user?.full_name || ""}
                            disabled
                            className="bg-slate-50"
                        />
                    </FormField>

                    <FormField>
                        <FormLabel>Vai trò</FormLabel>
                        <Input
                            value={user?.role || "operator"}
                            disabled
                            className="bg-slate-50 capitalize"
                        />
                    </FormField>
                </div>
                <p className="mt-4 text-xs text-slate-500">
                    Thông tin danh tính do dịch vụ xác thực quản lý. Việc quản trị
                    người dùng và phân quyền đô thị thuộc sản phẩm SynapseCity.
                </p>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 p-6">
                <h2 className="text-lg font-semibold mb-4">Đổi mật khẩu</h2>
                <Form onSubmit={handlePasswordSubmit}>
                    <div className="space-y-4">
                        <FormField>
                            <FormLabel required>Mật khẩu hiện tại</FormLabel>
                            <Input
                                type="password"
                                value={passwordData.current_password}
                                onChange={(e) =>
                                    setPasswordData({
                                        ...passwordData,
                                        current_password: e.target.value,
                                    })
                                }
                                placeholder="••••••••"
                            />
                        </FormField>

                        <FormField>
                            <FormLabel required>Mật khẩu mới</FormLabel>
                            <Input
                                type="password"
                                value={passwordData.new_password}
                                onChange={(e) =>
                                    setPasswordData({
                                        ...passwordData,
                                        new_password: e.target.value,
                                    })
                                }
                                placeholder="••••••••"
                            />
                        </FormField>

                        <FormField>
                            <FormLabel required>Xác nhận mật khẩu mới</FormLabel>
                            <Input
                                type="password"
                                value={passwordData.confirm_password}
                                onChange={(e) =>
                                    setPasswordData({
                                        ...passwordData,
                                        confirm_password: e.target.value,
                                    })
                                }
                                placeholder="••••••••"
                            />
                        </FormField>
                    </div>

                    {errors.password && (
                        <FormError>{errors.password}</FormError>
                    )}

                    <div className="flex gap-4 mt-6">
                        <Button
                            type="submit"
                            disabled={changePasswordMutation.isPending}
                        >
                            {changePasswordMutation.isPending
                                ? "Đang thay đổi..."
                                : "Đổi mật khẩu"}
                        </Button>
                    </div>
                </Form>
            </div>

            <div className="bg-white rounded-lg border border-slate-200 p-6">
                <h2 className="text-lg font-semibold mb-4">Hành động tài khoản</h2>
                <div className="flex gap-4">
                    <Button
                        type="button"
                        variant="destructive"
                        onClick={handleLogout}
                    >
                        Đăng xuất
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default ProfileSettings;
