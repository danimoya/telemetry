#!/usr/bin/perl
# nano-mask-argv <pid> <port> [timeout-seconds]
#
# HeliosDB-Nano 4.41 takes the SCRAM password only as `--password <value>` (no environment variable
# or file option), so the value sits in the engine's argv, and any host user can read argv through
# /proc/<pid>/cmdline. Once the engine has parsed its arguments and is listening on <port>, this
# overwrites the value's bytes in the engine's own argv memory with '*' (through /proc/<pid>/mem; it
# runs as the engine's uid, so no capability is needed). Afterwards cmdline shows
# `--password ****…`. The engine never reads argv again after startup (checked in the 4.41.0 source:
# no env::args after clap parses).
#
# What this does not cover: the value is readable from exec until the listener is up (normally
# under a second, at each engine start). Exits 1 with a warning if it cannot mask the value.
use strict;
use warnings;

my ($pid, $port, $timeout) = @ARGV;
die "usage: $0 <pid> <port> [timeout]\n" unless defined $port && $pid =~ /^\d+$/ && $port =~ /^\d+$/;
$timeout = 600 unless defined $timeout && $timeout =~ /^\d+$/;

sub fail { print STDERR "[nano] WARNING: --password NOT masked in the engine's command line: $_[0]\n"; exit 1 }

my $hexport = sprintf('%04X', $port);
sub listening {
  for my $file ('/proc/net/tcp', '/proc/net/tcp6') {
    open(my $fh, '<', $file) or next;
    while (my $row = <$fh>) {
      my @c = split ' ', $row;
      return 1 if @c > 3 && $c[1] =~ /:$hexport$/ && $c[3] eq '0A';
    }
  }
  return 0;
}
sub is_engine { my $exe = readlink("/proc/$pid/exe") // ''; return $exe =~ m{/heliosdb-nano$} }

my $deadline = time + $timeout;
until (is_engine() && listening()) {
  fail("engine pid $pid is gone") unless -e "/proc/$pid";
  fail("engine not listening on :$port after ${timeout}s") if time > $deadline;
  select(undef, undef, undef, 0.05);
}

open(my $st, '<', "/proc/$pid/stat") or fail("read /proc/$pid/stat: $!");
my $stat = <$st>;
close $st;
$stat =~ s/^.*\)\s+//s;               # drop "pid (comm) "; $f[0] is now field 3
my @f = split ' ', $stat;
my ($arg_start, $arg_end) = @f[45, 46]; # fields 48 and 49 (proc(5))
fail('no arg_start/arg_end in stat') unless defined $arg_end && $arg_end > $arg_start;

open(my $mem, '+<:raw', "/proc/$pid/mem") or fail("open /proc/$pid/mem: $!");
sysseek($mem, $arg_start, 0) or fail("seek: $!");
my $len = $arg_end - $arg_start;
(sysread($mem, my $buf, $len) // -1) == $len or fail("read argv: $!");

my @args = split /\0/, $buf, -1;
my ($offset, $masked) = (0, 0);
for my $i (0 .. $#args - 1) {
  if ($args[$i] eq '--password' && length $args[$i + 1]) {
    my $at = $arg_start + $offset + length($args[$i]) + 1;
    my $n = length $args[$i + 1];
    sysseek($mem, $at, 0) or fail("seek: $!");
    (syswrite($mem, '*' x $n) // -1) == $n or fail("write: $!");
    $masked++;
  }
  $offset += length($args[$i]) + 1;
}
close $mem;
fail('no --password argument found') unless $masked;

# Verify through the same interface a host user reads.
open(my $cl, '<:raw', "/proc/$pid/cmdline") or fail("read cmdline: $!");
my @now = split /\0/, do { local $/; <$cl> };
for my $i (0 .. $#now - 1) {
  fail('value still visible after the write') if $now[$i] eq '--password' && $now[$i + 1] !~ /^\*+$/;
}
print "[nano] --password masked in the engine's command line\n";
exit 0;
