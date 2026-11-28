#if Ver < EncodeVer(6, 7, 0) || Ver >= EncodeVer(7, 0, 0)
  #error This installer requires Inno Setup 6.7 or later in the 6.x series.
#endif

#define AppGuid "39333212-C9F8-43BC-A95F-6DDE9D02A4FB"
#define GuardName "setup-guard-" + GuardHash + ".exe"

[Setup]
AppId={{{#AppGuid}}
AppName=Node Goblin
AppVersion={#ReleaseVersion}
AppPublisher=Node Goblin
DefaultDirName={localappdata}\NodeGoblin\app
UsePreviousAppDir=no
DisableDirPage=yes
DefaultGroupName=Node Goblin
DisableProgramGroupPage=yes
UsePreviousGroup=no
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
MinVersion=10.0
CloseApplications=no
CloseApplicationsFilterExcludes=*
RestartApplications=no
RedirectionGuard=yes
UninstallDisplayIcon={app}\NodeGoblin.exe
VersionInfoVersion={#NumericVersion}
VersionInfoTextVersion={#ReleaseVersion}
VersionInfoProductVersion={#NumericVersion}
VersionInfoProductTextVersion={#ReleaseVersion}
VersionInfoProductName=Node Goblin
VersionInfoDescription=Node Goblin Windows Setup
Compression=lzma2
SolidCompression=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#StageRoot}\setup-guard.exe"; Flags: dontcopy
Source: "{#StageRoot}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Node Goblin"; Filename: "{app}\NodeGoblin.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\Node Goblin"; Filename: "{app}\NodeGoblin.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\NodeGoblin.exe"; WorkingDir: "{app}"; Description: "Launch Node Goblin"; Flags: postinstall nowait skipifsilent

[Code]
const
  RunKey = 'Software\Microsoft\Windows\CurrentVersion\Run';
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppGuid}}_is1';

type
  // Inno Setup 6 runs the script in its 32-bit process, including in 64-bit install mode.
  TSecurityAttributes = record
    Length, Descriptor, InheritHandle: LongWord;
  end;

var
  OperationMutex, ManagerMutex: LongWord;

function CreateMutexW(var Security: TSecurityAttributes; InitialOwner: LongBool; Name: string): LongWord;
  external 'CreateMutexW@kernel32.dll stdcall';
function WaitForSingleObject(Handle, Milliseconds: LongWord): LongWord;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function ReleaseMutex(Handle: LongWord): LongBool;
  external 'ReleaseMutex@kernel32.dll stdcall';
function CloseHandle(Handle: LongWord): LongBool;
  external 'CloseHandle@kernel32.dll stdcall';
function LocalFree(Address: LongWord): LongWord;
  external 'LocalFree@kernel32.dll stdcall';
function ConvertStringSecurityDescriptorToSecurityDescriptorW(
  Sddl: string; Revision: LongWord; var Descriptor: LongWord; Size: LongWord): LongBool;
  external 'ConvertStringSecurityDescriptorToSecurityDescriptorW@advapi32.dll stdcall';

function GetFileAttributesW(Path: string): Cardinal;
  external 'GetFileAttributesW@kernel32.dll stdcall';

function ExpectedApp: string;
begin
  Result := ExpandConstant('{localappdata}\NodeGoblin\app');
end;

procedure RequireFixedPath;
var
  Path: string;
begin
  Path := ExpectedApp;
  if Copy(Path, 2, 2) <> ':\' then
    RaiseException('Local AppData must be on a local Windows drive.');
  if not SameText(ExpandConstant('{app}'), Path) then
    RaiseException('Setup must use the per-user application folder: ' + Path);
end;

procedure LockMutex(const Name, Sddl, Failure: string; var Handle: LongWord);
var
  Security: TSecurityAttributes;
  Descriptor, WaitResult: LongWord;
begin
  Security.Length := SizeOf(Security);
  Descriptor := 0;
  Security.InheritHandle := 0;
  if Sddl <> '' then
    if not ConvertStringSecurityDescriptorToSecurityDescriptorW(Sddl, 1, Descriptor, 0) then
      RaiseException('Could not prepare the Node Goblin installation lock.');
  Security.Descriptor := Descriptor;
  try
    Handle := CreateMutexW(Security, False, Name);
    if Handle = 0 then
      RaiseException(Failure);
    WaitResult := WaitForSingleObject(Handle, 0);
    if (WaitResult <> 0) and (WaitResult <> $80) then
    begin
      CloseHandle(Handle);
      Handle := 0;
      RaiseException(Failure);
    end;
  finally
    if Security.Descriptor <> 0 then
      LocalFree(Security.Descriptor);
  end;
end;

procedure UnlockMutex(var Handle: LongWord);
begin
  if Handle <> 0 then
  begin
    ReleaseMutex(Handle);
    CloseHandle(Handle);
    Handle := 0;
  end;
end;

procedure LockOperation;
begin
  LockMutex('Global\Burrow.NodeGoblin.Setup.' + GetSHA256OfUnicodeString(Lowercase(ExpectedApp)), '',
    'Another Node Goblin install or uninstall is already running.', OperationMutex);
end;

procedure RunGuard(const Guard, Ownership: string);
var
  ExitCode: Integer;
  Sid: string;
  Output: TExecOutput;
begin
  if not ExecAndCaptureOutput(Guard, '"' + ExpectedApp + '" ' + Ownership,
      ExpandConstant('{sys}'), SW_HIDE, ewWaitUntilTerminated, ExitCode, Output) then
    RaiseException('Could not start the Node Goblin installation safety check: ' + SysErrorMessage(ExitCode));
  if ExitCode <> 0 then
  begin
    if GetArrayLength(Output.StdErr) > 0 then
      RaiseException(Output.StdErr[0]);
    RaiseException('The Node Goblin installation safety check failed.');
  end;
  if Output.Error or (GetArrayLength(Output.StdOut) <> 1) then
    RaiseException('The Node Goblin installation safety check did not identify the current user.');
  Sid := Output.StdOut[0];
  // Hold the manager's own per-user mutex until the files are replaced or removed.
  LockMutex('Global\Burrow.NodeGoblin.Manager.' + Sid,
    'O:' + Sid + 'D:P(A;;GA;;;' + Sid + ')(A;;GA;;;SY)(A;;GA;;;BA)',
    'Node Goblin is running. Close the manager and run Setup again.', ManagerMutex);
end;

function InitializeSetup: Boolean;
begin
  Result := not IsAdmin;
  if not Result then
    SuppressibleMsgBox('Run Node Goblin Setup as the signed-in user without elevation.', mbError, MB_OK, IDOK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): string;
var
  RegisteredPath, Ownership: string;
begin
  Result := '';
  try
    RequireFixedPath;
    LockOperation;
    Ownership := 'new';
    if RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', RegisteredPath) then
    begin
      if not SameText(RemoveBackslashUnlessRoot(RegisteredPath), ExpectedApp) then
        RaiseException('The registered Node Goblin installation has an unexpected path.');
      Ownership := 'owned';
    end;
    ExtractTemporaryFile('setup-guard.exe');
    RunGuard(ExpandConstant('{tmp}\setup-guard.exe'), Ownership);
  except
    Result := GetExceptionMessage;
    Log(Result);
    UnlockMutex(ManagerMutex);
    UnlockMutex(OperationMutex);
  end;
end;

procedure CurStepChanged(Step: TSetupStep);
begin
  if Step = ssPostInstall then
    UnlockMutex(ManagerMutex);
end;

procedure DeinitializeSetup;
begin
  UnlockMutex(ManagerMutex);
  UnlockMutex(OperationMutex);
end;

procedure RequirePlainDirectory(const Directory: string);
var
  Parent: string;
  Attributes: Cardinal;
begin
  Parent := ExtractFileDir(RemoveBackslashUnlessRoot(Directory));
  if (Parent <> '') and (Length(Directory) > 3) then
    RequirePlainDirectory(Parent);
  Attributes := GetFileAttributesW(Directory);
  if (Attributes = $FFFFFFFF) or ((Attributes and $410) <> $10) then
    RaiseException('Unsafe Node Goblin directory: ' + Directory);
end;

procedure VerifyInstalledGuard(const Guard: string);
var
  Attributes: Cardinal;
begin
  // Check each parent before opening the executable. The guard checks ACLs and file links.
  RequirePlainDirectory(ExtractFileDir(Guard));
  Attributes := GetFileAttributesW(Guard);
  if (Attributes = $FFFFFFFF) or ((Attributes and $410) <> 0) then
    RaiseException('The installed Node Goblin safety check is missing or linked.');
  if not SameText(GetSHA256OfFile(Guard), '{#GuardHash}') then
    RaiseException('The installed Node Goblin safety check has been modified.');
end;

function InitializeUninstall: Boolean;
begin
  Result := not IsAdmin;
  if not Result then
    SuppressibleMsgBox('Uninstall Node Goblin as the signed-in user without elevation.', mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(Step: TUninstallStep);
var
  Guard, Error, Command: string;
begin
  if Step = usAppMutexCheck then
  begin
    try
      RequireFixedPath;
      LockOperation;
      Guard := ExpectedApp + '\{#GuardName}';
      VerifyInstalledGuard(Guard);
      RunGuard(Guard, 'owned');
    except
      Error := GetExceptionMessage;
      Log(Error);
      SuppressibleMsgBox(Error, mbError, MB_OK, IDOK);
      Abort;
    end;
  end;
  if (Step = usPostUninstall) and RegQueryStringValue(HKCU, RunKey, 'NodeGoblin', Command) then
    if SameText(Command, '"' + ExpectedApp + '\NodeGoblin.exe" --background') then
      if not RegDeleteValue(HKCU, RunKey, 'NodeGoblin') then
        Log('Could not remove the Node Goblin sign-in entry.');
end;

procedure DeinitializeUninstall;
begin
  UnlockMutex(ManagerMutex);
  UnlockMutex(OperationMutex);
end;
