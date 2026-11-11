/* Build-time only, native x86-64. See README for pinned provenance/reproduction.
 * Namespace/mount/clone/terminal rules follow Flatpak 1.16.1 setup_seccomp.
 * Rule selection is Dirac's restricted command policy, not Flatpak's full policy.
 */
#define _GNU_SOURCE
#include <seccomp.h>
#include <errno.h>
#include <sched.h>
#include <sys/ioctl.h>
#include <linux/tiocl.h>
#include <unistd.h>
#include <stdio.h>

#define CHECK(call) do { if ((call) < 0) { perror(#call); return 1; } } while (0)
int main(void) {
    if (seccomp_arch_native() != SCMP_ARCH_X86_64) return 1;
    const struct scmp_version *version = seccomp_version();
    if (version->major != 2 || version->minor != 6 || version->micro != 0) return 1;
    scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
    if (!ctx) return 1;
    CHECK(seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS));
    const char *denied[] = {"unshare", "setns", "mount", "umount2", "pivot_root", "chroot",
        "ptrace", "process_vm_readv", "process_vm_writev", "pidfd_getfd"};
    const char *missing[] = {"clone3", "open_tree", "move_mount", "fsopen", "fsconfig",
        "fsmount", "fspick", "mount_setattr"};
    for (unsigned i=0; i<sizeof(denied)/sizeof(*denied); i++) {
        int nr = seccomp_syscall_resolve_name(denied[i]);
        if (nr == __NR_SCMP_ERROR) return 1;
        CHECK(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0));
    }
    for (unsigned i=0; i<sizeof(missing)/sizeof(*missing); i++) {
        int nr = seccomp_syscall_resolve_name(missing[i]);
        if (nr == __NR_SCMP_ERROR) return 1;
        CHECK(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), nr, 0));
    }
    CHECK(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
        SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)));
    CHECK(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ioctl), 1,
        SCMP_A1(SCMP_CMP_MASKED_EQ, 0xffffffff, TIOCSTI)));
    CHECK(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ioctl), 1,
        SCMP_A1(SCMP_CMP_MASKED_EQ, 0xffffffff, TIOCLINUX)));
    CHECK(seccomp_export_bpf(ctx, STDOUT_FILENO));
    seccomp_release(ctx);
    return 0;
}
